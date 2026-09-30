import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_VERSION, SLOT_MS, SlotAccumulator, activityDocId, slotStartOf, type ActivitySlot } from '@timetracking/shared';
import { activity, createHarness, hello, type Harness } from './fakes';

/** Start of a 10-minute block. */
const SLOT0 = slotStartOf(1_790_000_000_000) + SLOT_MS;
const MEET = 'https://meet.google.com/abc-defg-hij?authuser=0';
const TEAMS = 'https://teams.microsoft.com/v2/';
const AUDIBLE_KEY = 'tt.audibleTabs';

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function pulse(h: Harness): Promise<void> {
  await h.app.session.pulse();
  await h.settle();
}

function current(h: Harness): ActivitySlot | null {
  const acc = h.app.store.acc;
  if (!acc) return null;
  return SlotAccumulator.fromJSON(acc.toJSON()).flush(acc.lastEventAt ?? Date.now()).current;
}

describe('Tracker — web meetings ("En reunión")', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const win = () => h.chrome.world.windows[0]!;
  const tab = (id: number) => win().tabs.find((t) => t.id === id)!;
  const tabObj = (id: number) => ({ ...tab(id), windowId: 1 }) as chrome.tabs.Tab;

  /** Adds a background meeting tab (id 13) to the focused window. */
  function addMeetingTab(url = MEET, audible = true): void {
    win().tabs.push({ id: 13, url, active: false, audible });
  }

  /** Makes `id` the active tab of the focused window. */
  async function activate(id: number): Promise<void> {
    for (const t of win().tabs) t.active = t.id === id;
    await h.app.tracker.onTabActivated();
  }

  /** The tab stops (or starts) playing audio: Chrome fires tabs.onUpdated. */
  async function setAudible(id: number, audible: boolean): Promise<void> {
    tab(id).audible = audible;
    await h.app.tracker.onTabUpdated(id, { audible }, tabObj(id));
  }

  /** Pulses every 30 s for `ms`. */
  async function run(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 30_000) {
      await advance(30_000);
      await pulse(h);
    }
  }

  it('meeting in a background tab with audio: seconds without input are meeting, with input active', async () => {
    await hello(h, 11); // writing in Docs (measurable)
    addMeetingTab();
    await h.app.session.start();
    await advance(15_000);
    await activity(h, 11);
    await advance(1_000);
    await activity(h, 11);
    await advance(14_000);
    await pulse(h);
    const slot = current(h)!;
    expect(slot).toMatchObject({ trackedSeconds: 30, activeSeconds: 2, meetingSeconds: 28 });
    // Time is still attributed to the focused tab, not to the meeting tab.
    expect(slot.domains).toEqual({ 'docs.example.com': 30 });
    expect(h.app.store.acc!.inMeeting).toBe(true);
  });

  it('a room in front counts without audio (listening, no keyboard/mouse)', async () => {
    tab(11).url = MEET;
    await hello(h, 11);
    await h.app.session.start();
    await run(60_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 60, activeSeconds: 0, meetingSeconds: 60 });
    expect(current(h)!.domains).toEqual({ 'meet.google.com': 60 });
  });

  it('a background room stops counting 2 min after its last audio (checked by the pulse)', async () => {
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    await advance(10_000);
    await setAudible(13, false); // last audio at +10 s
    await advance(20_000);
    await pulse(h); // +30 s
    await run(150_000); // pulses at +60 … +180 s
    const slot = current(h)!;
    expect(slot.trackedSeconds).toBe(180);
    // Pulse at +120 s: 110 s since the audio → still a meeting; at +150 s: 140 s → no longer.
    expect(slot.meetingSeconds).toBe(150);
    expect(h.app.store.acc!.inMeeting).toBe(false);
    expect(h.chrome.session.data[AUDIBLE_KEY]).toEqual({}); // expired mark forgotten
    // Audio again → counts again from that instant.
    await setAudible(13, true);
    await run(30_000);
    expect(current(h)!.meetingSeconds).toBe(180);
  });

  it('a background room that never played audio does not count', async () => {
    await hello(h, 11);
    addMeetingTab(MEET, false);
    await h.app.session.start();
    await run(60_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 60, meetingSeconds: 0 });
  });

  it('the last audio instant survives a service-worker restart (chrome.storage.session)', async () => {
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    await advance(10_000);
    await setAudible(13, false);
    expect(h.chrome.session.data[AUDIBLE_KEY]).toEqual({ '13': SLOT0 + 70_000 });
    await h.restart();
    await advance(20_000);
    await pulse(h);
    expect(current(h)!.meetingSeconds).toBe(30);
    expect(h.app.store.acc!.inMeeting).toBe(true);
  });

  it('Teams without audio does not count, even in front; with recent audio it does', async () => {
    tab(11).url = TEAMS;
    await hello(h, 11);
    await h.app.session.start();
    await run(30_000);
    expect(current(h)!.meetingSeconds).toBe(0);
    await setAudible(11, true);
    await run(30_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 60, meetingSeconds: 30 });
  });

  it('Teams in the background with audio counts; its chat with audio does not', async () => {
    await hello(h, 11);
    addMeetingTab(TEAMS, true);
    await h.app.session.start();
    await run(30_000);
    expect(current(h)!.meetingSeconds).toBe(30);
    tab(13).url = 'https://teams.microsoft.com/_#/conversations/General';
    await h.app.tracker.onTabUpdated(13, { url: tab(13).url }, tabObj(13));
    await run(30_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 60, meetingSeconds: 30 });
  });

  it('a meeting in an incognito window or in a devtools window does not count', async () => {
    await hello(h, 11);
    h.chrome.world.windows.push(
      { id: 2, focused: false, incognito: true, tabs: [{ id: 21, url: MEET, active: true, audible: true }] },
      { id: 3, focused: false, type: 'devtools', tabs: [{ id: 31, url: MEET, active: true, audible: true }] },
    );
    await h.app.session.start();
    await run(30_000);
    expect(current(h)!.meetingSeconds).toBe(0);
    expect(h.chrome.session.data[AUDIBLE_KEY] ?? {}).toEqual({});
  });

  it.each(['app', 'popup'] as const)('a meeting in an installed web app / pop-out (%s window) counts', async (type) => {
    await hello(h, 11);
    h.chrome.world.windows.push({ id: 3, focused: false, type, tabs: [{ id: 31, url: MEET, active: true, audible: true }] });
    await h.app.session.start();
    await run(30_000);
    expect(current(h)!.meetingSeconds).toBe(30);
  });

  it('screen locked: not a meeting, even with the room playing audio', async () => {
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    await run(30_000);
    h.chrome.world.idleState = 'locked';
    await h.app.tracker.onIdleState('locked');
    await run(60_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 90, activeSeconds: 0, meetingSeconds: 30 });
    expect(h.app.store.acc!.inMeeting).toBe(false);
  });

  it('a work day opened before accepting the new notice (0.1.1) does not detect meetings until it is accepted', async () => {
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    // As after updating 0.1.1 → 0.1.2 with the work day open: old notice.
    h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: '2026-09-29' };
    await pulse(h);
    await run(60_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 60, meetingSeconds: 0 });
    // Accepted: detected from the next evaluation (here, the next pulse).
    h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: CONSENT_VERSION };
    await run(60_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 120, meetingSeconds: 30 });
  });

  it('tabs.onUpdated of unrelated background tabs does not re-read every tab (cost)', async () => {
    await hello(h, 11);
    win().tabs.push({ id: 14, url: 'https://news.example.com/', active: false });
    await h.app.session.start();
    await h.settle();
    const getAll = vi.spyOn(chrome.windows, 'getAll');
    const saves = h.chrome.local.setCalls.length;
    for (let i = 0; i < 20; i++) {
      tab(14).url = `https://news.example.com/${i}`;
      await h.app.tracker.onTabUpdated(14, { status: 'loading', url: tab(14).url }, tabObj(14));
      await h.app.tracker.onTabUpdated(14, { status: 'complete' }, tabObj(14));
      await h.app.tracker.onTabUpdated(14, { audible: false }, tabObj(14));
    }
    expect(getAll).not.toHaveBeenCalled();
    expect(h.chrome.local.setCalls.length).toBe(saves);
    // A background tab that becomes a room with audio is picked up at once.
    tab(14).url = MEET;
    tab(14).audible = true;
    await h.app.tracker.onTabUpdated(14, { audible: true }, tabObj(14));
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(h.app.store.acc!.inMeeting).toBe(true);
  });

  it('a focused incognito window with a room: outside Chrome and not a meeting', async () => {
    win().focused = false;
    h.chrome.world.windows.push({ id: 2, focused: true, incognito: true, tabs: [{ id: 21, url: MEET, active: true }] });
    await h.app.session.start();
    await run(30_000);
    expect(current(h)).toMatchObject({ trackedSeconds: 30, outsideChromeSeconds: 30, meetingSeconds: 0 });
  });

  it('closing the meeting tab ends the meeting at once', async () => {
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    await advance(10_000);
    win().tabs.splice(win().tabs.findIndex((t) => t.id === 13), 1);
    await h.app.tracker.onTabRemoved(13);
    await advance(20_000);
    await pulse(h);
    expect(current(h)).toMatchObject({ trackedSeconds: 30, meetingSeconds: 10 });
    expect(h.chrome.session.data[AUDIBLE_KEY]).toEqual({});
  });

  it('navigating the room tab away (url change) ends the meeting', async () => {
    addMeetingTab(MEET, false);
    await hello(h, 13);
    for (const t of win().tabs) t.active = t.id === 13;
    await h.app.session.start(); // room in front, silent
    await advance(10_000);
    tab(13).url = 'https://meet.google.com/';
    await h.app.tracker.onTabUpdated(13, { url: tab(13).url }, tabObj(13));
    await advance(20_000);
    await pulse(h);
    expect(current(h)!.meetingSeconds).toBe(10);
  });

  it('a silent room counts only while in front (onActivated, windows.onFocusChanged)', async () => {
    addMeetingTab(MEET, false);
    await hello(h, 13); // measurable: no keyboard/mouse there means not active
    for (const t of win().tabs) t.active = t.id === 13;
    await h.app.session.start();
    await advance(10_000); // 0–10 s in front → meeting
    await activate(11);
    await advance(10_000); // 10–20 s another tab → not a meeting
    await activate(13);
    await advance(10_000); // 20–30 s in front again → meeting
    win().focused = false;
    await h.app.tracker.onWindowFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await h.app.tracker.onIdleState('idle');
    await advance(10_000); // 30–40 s another app → not a meeting
    await pulse(h);
    const slot = current(h)!;
    expect(slot.trackedSeconds).toBe(40);
    expect(slot.meetingSeconds).toBe(20);
  });

  it('a meeting crossing a block boundary is split between both blocks', async () => {
    vi.setSystemTime(SLOT0 + SLOT_MS - 20_000);
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    await run(30_000);
    const uid = h.app.store.session!.uid;
    expect(h.backend.activity.get(activityDocId(uid, SLOT0))).toMatchObject({ trackedSeconds: 20, meetingSeconds: 20 });
    expect(current(h)).toMatchObject({ slotStart: SLOT0 + SLOT_MS, trackedSeconds: 10, meetingSeconds: 10 });
  });

  it('uploads meetingSeconds and shows it in the popup totals of today', async () => {
    await hello(h, 11);
    addMeetingTab();
    await h.app.session.start();
    const uid = h.app.store.session!.uid;
    await run(60_000);
    await h.app.session.stop();
    await h.settle();
    const doc = h.backend.activity.get(activityDocId(uid, SLOT0));
    expect(doc).toMatchObject({ trackedSeconds: 60, activeSeconds: 0, meetingSeconds: 60 });
    expect((await h.app.status()).today).toEqual({ trackedSeconds: 60, activeSeconds: 0, meetingSeconds: 60 });
  });

  it('records the audio of tabs even without a work day, but measures nothing', async () => {
    addMeetingTab(MEET, false);
    await setAudible(13, true);
    expect(h.chrome.session.data[AUDIBLE_KEY]).toEqual({ '13': SLOT0 + 60_000 });
    expect(h.app.store.acc).toBeNull();
  });
});
