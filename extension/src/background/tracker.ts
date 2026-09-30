/**
 * Feeds the `SlotAccumulator` (packages/shared) from Chrome events (spec 3.1–3.2).
 *
 * - Idle: `chrome.idle` with a 15 s threshold → `setIdleState`. `locked` also
 *   means nobody is looking at Chrome → `setFocus(null)`.
 * - Focus: active tab of the focused window (`tabs.onActivated`,
 *   `tabs.onUpdated`, `windows.onFocusChanged`). `WINDOW_ID_NONE` (another
 *   app is focused) → `null` = outside Chrome.
 * - Measurable page: the content script of that tab already said hello (or
 *   sent activity) from the tab's current origin. Otherwise (chrome://, Web
 *   Store, PDF viewer, page still loading…) `measurable: false`, so the
 *   accumulator falls back to `chrome.idle` for activity.
 * - Activity: `{ type: 'activity', t }` from the content script →
 *   `markActiveSecond`.
 * - Web meeting (spec 2026-09-30, "En reunión") → `setMeeting`: some tab of
 *   a normal, popup or app (PWA) window, not incognito, is a meeting room
 *   (`isMeetingUrl`) and
 *   either it is the active tab of the focused window, or it is playing
 *   audio (`tab.audible`), or it did so at most 2 min ago. Teams always needs
 *   recent audio (its URLs do not tell a meeting from the chat). Only the
 *   URL and the `audible` flag are read: never the audio or the video.
 *   Never while the screen is locked, nor before the notice that describes
 *   it (CONSENT_VERSION) was accepted.
 *   Re-evaluated on `tabs.onUpdated` (only the events that can change it),
 *   `onActivated`,
 *   `onRemoved`, `windows.onFocusChanged`, idle changes and every 30 s pulse
 *   (which also covers the end of the 2-minute grace period).
 *
 * The set of measurable tabs and the "last audible" instant per tab live in
 * `chrome.storage.session` (tab ids are only valid for the browser session)
 * so they survive service-worker restarts.
 *
 * Every handler runs inside `store.run()` (serialized) and only measures when
 * a work day is open; the timestamp is taken when the event arrives.
 */
import {
  CONSENT_VERSION,
  IDLE_DETECTION_SECONDS,
  MEETING_AUDIO_GRACE_MS,
  SlotAccumulator,
  isMeetingInProgress,
  isMeetingUrl,
  type FlushResult,
  type FocusInput,
  type IdleState,
} from '@timetracking/shared';
import type { ContentMessage } from '../messages';
import { enqueueOp } from './queue';
import type { StateStore, StorageAreaLike } from './state';

const TABS_KEY = 'tt.measurableTabs';
/** tabId → last instant (ms) the tab was seen playing audio. */
const AUDIBLE_KEY = 'tt.audibleTabs';
/** Activity timestamps from content scripts are trusted within this window. */
const MAX_ACTIVITY_SKEW_MS = 10_000;

/** Origin of an http(s) URL, or null. */
export function httpOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export interface TrackerDeps {
  store: StateStore;
  now?: () => number;
  /** Where measurable tab ids are kept; defaults to chrome.storage.session. */
  sessionArea?: StorageAreaLike | null;
}

export class Tracker {
  private readonly store: StateStore;
  private readonly now: () => number;
  private readonly sessionArea: StorageAreaLike | null;
  /** tabId → origin that the content script reported from. */
  private tabs: Map<number, string> | null = null;
  /** tabId → last instant the tab was audible. */
  private audible: Map<number, number> | null = null;

  constructor(deps: TrackerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.sessionArea =
      deps.sessionArea !== undefined ? deps.sessionArea : (chrome.storage.session ?? null);
  }

  /** Registers the Chrome listeners. Must run synchronously at SW start-up. */
  register(): void {
    chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
    chrome.idle.onStateChanged.addListener((state) => void this.onIdleState(state));
    chrome.tabs.onActivated.addListener(() => void this.onTabActivated());
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => void this.onTabUpdated(tabId, info, tab));
    chrome.tabs.onRemoved.addListener((tabId) => void this.onTabRemoved(tabId));
    chrome.windows.onFocusChanged.addListener((windowId) => void this.onWindowFocusChanged(windowId));
  }

  // ---------- event handlers ----------

  onIdleState(state: IdleState): Promise<void> {
    const at = this.now();
    return this.store.run(async () => {
      const acc = this.measuringAcc();
      if (!acc) return;
      acc.setIdleState(state, at);
      if (state === 'locked') acc.setFocus(null, at);
      else acc.setFocus(await this.computeFocus(), at);
      acc.setMeeting(await this.computeMeeting(at, state), at);
      await this.store.save('acc');
    });
  }

  onTabActivated(): Promise<void> {
    return this.refreshFocus(this.now());
  }

  onTabUpdated(tabId: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): Promise<void> {
    const at = this.now();
    return this.store.run(async () => {
      // A new document is loading: its content script has not said hello yet.
      if (info.status === 'loading') await this.forgetTab(tabId);
      // Started or stopped playing audio: either way it was audible until now.
      if (info.audible !== undefined && !tab.incognito) await this.markAudible(tabId, at);
      const navigated = info.url !== undefined || info.status !== undefined;
      if (!navigated && info.audible === undefined) return;
      const acc = this.measuringAcc();
      if (!acc) return;
      const focusChanged = tab.active && navigated;
      // Cost: onUpdated fires for every tab of every window. Only events that
      // can change the meeting state re-read all tabs (windows.getAll):
      // - audio starting while not in a meeting (stopping it, or more audio
      //   during a meeting, cannot end it: the 2-min grace covers it);
      // - a navigation of a room tab, or of any tab while in a meeting (the
      //   room may have been left);
      // - the active tab navigating (it may have become/stopped being a room).
      // The 30 s pulse re-evaluates everything anyway.
      const meetingMayChange =
        focusChanged ||
        (info.audible === true && !acc.inMeeting) ||
        (navigated && (acc.inMeeting || isMeetingUrl(tab.url ?? tab.pendingUrl)));
      if (!meetingMayChange) return;
      if (focusChanged) {
        acc.setFocus(acc.idleState === 'locked' ? null : await this.computeFocus(), at);
      }
      acc.setMeeting(await this.computeMeeting(at, acc.idleState), at);
      await this.store.save('acc');
    });
  }

  onTabRemoved(tabId: number): Promise<void> {
    const at = this.now();
    return this.store.run(async () => {
      await this.forgetTab(tabId);
      await this.forgetAudible(tabId);
      const acc = this.measuringAcc();
      if (!acc) return;
      acc.setMeeting(await this.computeMeeting(at, acc.idleState), at);
      await this.store.save('acc');
    });
  }

  onWindowFocusChanged(windowId: number): Promise<void> {
    const at = this.now();
    return this.store.run(async () => {
      const acc = this.measuringAcc();
      if (!acc) return;
      const focus =
        windowId === chrome.windows.WINDOW_ID_NONE || acc.idleState === 'locked'
          ? null
          : await this.computeFocus(windowId);
      acc.setFocus(focus, at);
      acc.setMeeting(await this.computeMeeting(at, acc.idleState), at);
      await this.store.save('acc');
    });
  }

  /** `hello` / `activity` from a content script. */
  onContentMessage(msg: ContentMessage, sender: chrome.runtime.MessageSender): Promise<void> {
    const at = this.now();
    return this.store.run(async () => {
      const tabId = sender.tab?.id;
      if (tabId === undefined || (sender.frameId !== undefined && sender.frameId !== 0)) return;
      const origin = httpOrigin(sender.url ?? sender.tab?.url);
      const tabs = await this.loadTabs();
      let changed = false;
      if (origin !== null && tabs.get(tabId) !== origin) {
        tabs.set(tabId, origin);
        await this.saveTabs();
        changed = true;
      }
      const acc = this.measuringAcc();
      if (!acc) return;
      // The page just became measurable: re-evaluate the focus now.
      if (changed && sender.tab?.active) acc.setFocus(await this.computeFocus(), at);
      if (msg.type === 'activity') {
        const t = msg.t <= at && msg.t >= at - MAX_ACTIVITY_SKEW_MS ? msg.t : at;
        acc.markActiveSecond(t);
        this.store.markAccDirty();
      } else if (changed) {
        await this.store.save('acc');
      }
    });
  }

  // ---------- used by the session manager (call inside store.run) ----------

  /**
   * Opens the work day in the accumulator with the current idle state and
   * focus. The accumulator of another user is replaced; its blocks are queued
   * first (they keep their uid, so they are never sent with this account).
   * The caller persists the queue before the accumulator.
   */
  async beginMeasuring(sessionId: string, uid: string, at: number): Promise<SlotAccumulator> {
    const previous = this.store.acc;
    if (previous && previous.uid !== uid) {
      const { closed, current } = previous.flush(at);
      for (const slot of [...closed, ...(current ? [current] : [])]) {
        enqueueOp(this.store.queue, { kind: 'activity', uid: slot.uid, slot });
      }
    }
    const acc = previous && previous.uid === uid ? previous : new SlotAccumulator({ uid });
    this.store.acc = acc;
    acc.setSession(sessionId, at);
    const idle = await this.queryIdle();
    acc.setIdleState(idle, at);
    // The accumulator starts with focus null (outside Chrome): always set it.
    acc.setFocus(idle === 'locked' ? null : await this.computeFocus(), at);
    acc.setMeeting(await this.computeMeeting(at, idle), at);
    return acc;
  }

  /** Closes the work day in the accumulator (no more seconds are tracked). */
  endMeasuring(at: number): void {
    this.store.acc?.setSession(null, at);
  }

  /**
   * Alarm pulse: `tick` first (a gap > 90 s since the last event is discarded
   * as "no data"), then re-reads idle state and focus as a safety net for
   * events missed while the worker slept, then the meeting state (which also
   * ends a background meeting 2 min after its last audio), then `flush`.
   */
  async pulse(at: number): Promise<FlushResult | null> {
    const acc = this.store.acc;
    if (!acc) return null;
    acc.tick(at);
    if (acc.sessionId !== null) {
      const idle = await this.queryIdle();
      acc.setIdleState(idle, at);
      acc.setFocus(idle === 'locked' ? null : await this.computeFocus(), at);
      acc.setMeeting(await this.computeMeeting(at, idle), at);
    }
    return acc.flush(at);
  }

  // ---------- helpers ----------

  private measuringAcc(): SlotAccumulator | null {
    const acc = this.store.acc;
    return this.store.session && acc && acc.sessionId !== null ? acc : null;
  }

  private refreshFocus(at: number): Promise<void> {
    return this.store.run(() => this.refreshFocusLocked(at));
  }

  private async refreshFocusLocked(at: number): Promise<void> {
    const acc = this.measuringAcc();
    if (!acc) return;
    acc.setFocus(acc.idleState === 'locked' ? null : await this.computeFocus(), at);
    acc.setMeeting(await this.computeMeeting(at, acc.idleState), at);
    await this.store.save('acc');
  }

  private async queryIdle(): Promise<IdleState> {
    try {
      return await chrome.idle.queryState(IDLE_DETECTION_SECONDS);
    } catch {
      return 'active';
    }
  }

  /**
   * Active tab of the focused Chrome window, or null when no Chrome window is
   * focused. `windowId` comes from `windows.onFocusChanged` (already known to
   * be focused).
   */
  async computeFocus(windowId?: number): Promise<FocusInput | null> {
    try {
      let win: chrome.windows.Window;
      if (windowId !== undefined) {
        win = await chrome.windows.get(windowId, { populate: true });
      } else {
        win = await chrome.windows.getLastFocused({ populate: true });
        if (!win.focused) return null;
      }
      // The extension is not allowed in incognito: treat it as outside Chrome.
      if (win.incognito) return null;
      const tab = win.tabs?.find((t) => t.active);
      if (!tab || tab.id === undefined) return { url: '', measurable: false };
      const url = tab.url ?? tab.pendingUrl ?? '';
      const origin = httpOrigin(url);
      const tabs = await this.loadTabs();
      return { url, measurable: origin !== null && tabs.get(tab.id) === origin };
    } catch {
      // No window at all (all closed) or the window vanished meanwhile.
      return null;
    }
  }

  /**
   * Whether a web meeting is in progress at `at` in some tab of a normal,
   * non-incognito window (see the header). Also records which tabs are
   * audible right now and forgets closed tabs / expired audio marks.
   */
  async computeMeeting(at: number, idle: IdleState): Promise<boolean> {
    let windows: chrome.windows.Window[];
    try {
      // 'popup' and 'app' too: installed web apps (Meet/Teams PWA) and
      // pop-out meeting windows. Never devtools.
      windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app'] });
    } catch {
      return false;
    }
    const audible = await this.loadAudible();
    let changed = false;
    let meeting = false;
    const seen = new Set<number>();
    for (const win of windows) {
      if (win.incognito) continue; // the extension is not allowed there
      for (const tab of win.tabs ?? []) {
        if (tab.id === undefined || tab.incognito) continue;
        seen.add(tab.id);
        const isAudible = tab.audible === true;
        if (isAudible && audible.get(tab.id) !== at) {
          audible.set(tab.id, at);
          changed = true;
        }
        const inFront = win.focused === true && tab.active === true && idle !== 'locked';
        const url = tab.url || tab.pendingUrl;
        if (isMeetingInProgress({ url, inFront, audible: isAudible, lastAudibleAt: audible.get(tab.id) ?? null }, at)) {
          meeting = true;
        }
      }
    }
    for (const [id, last] of audible) {
      if (!seen.has(id) || at - last > MEETING_AUDIO_GRACE_MS) {
        audible.delete(id);
        changed = true;
      }
    }
    if (changed) await this.saveAudible();
    // Screen locked = the person is away (as for focus). And meeting
    // detection is only used once the notice that describes it (CONSENT_VERSION
    // 2026-09-30) was accepted: a work day opened with 0.1.1 keeps measuring
    // as before until the person accepts the new notice.
    if (idle === 'locked' || this.store.meta.profile?.consentVersion !== CONSENT_VERSION) return false;
    return meeting;
  }

  private async loadAudible(): Promise<Map<number, number>> {
    if (this.audible) return this.audible;
    const map = new Map<number, number>();
    if (this.sessionArea) {
      try {
        const raw = (await this.sessionArea.get(AUDIBLE_KEY))[AUDIBLE_KEY];
        if (raw && typeof raw === 'object') {
          for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof t === 'number' && Number.isFinite(t)) map.set(Number(id), t);
          }
        }
      } catch {
        // storage.session unavailable: keep it in memory only
      }
    }
    this.audible = map;
    return map;
  }

  private async saveAudible(): Promise<void> {
    if (!this.sessionArea || !this.audible) return;
    try {
      await this.sessionArea.set({ [AUDIBLE_KEY]: Object.fromEntries(this.audible) });
    } catch {
      // ignore: worst case a background meeting stops counting until its next audio
    }
  }

  private async markAudible(tabId: number, at: number): Promise<void> {
    const audible = await this.loadAudible();
    if (audible.get(tabId) === at) return;
    audible.set(tabId, at);
    await this.saveAudible();
  }

  private async forgetAudible(tabId: number): Promise<void> {
    const audible = await this.loadAudible();
    if (audible.delete(tabId)) await this.saveAudible();
  }

  private async loadTabs(): Promise<Map<number, string>> {
    if (this.tabs) return this.tabs;
    const map = new Map<number, string>();
    if (this.sessionArea) {
      try {
        const data = await this.sessionArea.get(TABS_KEY);
        const raw = data[TABS_KEY];
        if (raw && typeof raw === 'object') {
          for (const [id, origin] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof origin === 'string') map.set(Number(id), origin);
          }
        }
      } catch {
        // storage.session unavailable: keep it in memory only
      }
    }
    this.tabs = map;
    return map;
  }

  private async saveTabs(): Promise<void> {
    if (!this.sessionArea || !this.tabs) return;
    try {
      await this.sessionArea.set({ [TABS_KEY]: Object.fromEntries(this.tabs) });
    } catch {
      // ignore: worst case a page is treated as not measurable until its next activity
    }
  }

  private async forgetTab(tabId: number): Promise<void> {
    const tabs = await this.loadTabs();
    if (tabs.delete(tabId)) await this.saveTabs();
  }
}
