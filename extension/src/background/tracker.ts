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
 *
 * The set of measurable tabs lives in `chrome.storage.session` (tab ids are
 * only valid for the browser session) so it survives service-worker restarts.
 *
 * Every handler runs inside `store.run()` (serialized) and only measures when
 * a work day is open; the timestamp is taken when the event arrives.
 */
import {
  IDLE_DETECTION_SECONDS,
  SlotAccumulator,
  type FlushResult,
  type FocusInput,
  type IdleState,
} from '@timetracking/shared';
import type { ContentMessage } from '../messages';
import { enqueueOp } from './queue';
import type { StateStore, StorageAreaLike } from './state';

const TABS_KEY = 'tt.measurableTabs';
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
      if (!tab.active || (info.url === undefined && info.status === undefined)) return;
      await this.refreshFocusLocked(at);
    });
  }

  onTabRemoved(tabId: number): Promise<void> {
    return this.store.run(() => this.forgetTab(tabId));
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
    return acc;
  }

  /** Closes the work day in the accumulator (no more seconds are tracked). */
  endMeasuring(at: number): void {
    this.store.acc?.setSession(null, at);
  }

  /**
   * Alarm pulse: `tick` first (a gap > 90 s since the last event is discarded
   * as "no data"), then re-reads idle state and focus as a safety net for
   * events missed while the worker slept, then `flush`.
   */
  async pulse(at: number): Promise<FlushResult | null> {
    const acc = this.store.acc;
    if (!acc) return null;
    acc.tick(at);
    if (acc.sessionId !== null) {
      const idle = await this.queryIdle();
      acc.setIdleState(idle, at);
      acc.setFocus(idle === 'locked' ? null : await this.computeFocus(), at);
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
