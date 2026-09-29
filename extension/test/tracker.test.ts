import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_MS, SlotAccumulator, activityDocId, slotStartOf, type ActivitySlot } from '@timetracking/shared';
import { httpOrigin } from '../src/background/tracker';
import { activity, createHarness, hello, type Harness } from './fakes';

/** Start of a 10-minute block. */
const SLOT0 = slotStartOf(1_790_000_000_000) + SLOT_MS;

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Runs one alarm pulse and waits for the uploads. */
async function pulse(h: Harness): Promise<void> {
  await h.app.session.pulse();
  await h.settle();
}

function current(h: Harness): ActivitySlot | null {
  const acc = h.app.store.acc;
  if (!acc) return null;
  // Work on a copy: flush() drops closed blocks from the accumulator.
  return SlotAccumulator.fromJSON(acc.toJSON()).flush(acc.lastEventAt ?? Date.now()).current;
}

describe('Tracker', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers idle detection with a 15 s threshold', () => {
    expect(h.chrome.world.detectionInterval).toBe(15);
    expect(h.chrome.events.idleChanged.listeners).toHaveLength(1);
    expect(h.chrome.events.focusChanged.listeners).toHaveLength(1);
  });

  it('start sets session, idle state and focus on the accumulator (focus defaults to null)', async () => {
    await hello(h, 11);
    await h.app.session.start();
    const acc = h.app.store.acc!;
    expect(acc.sessionId).toBe(h.app.store.session!.id);
    expect(acc.idleState).toBe('active');
    await advance(30_000);
    await activity(h, 11);
    await advance(10_000);
    await pulse(h);
    const slot = current(h)!;
    expect(slot.trackedSeconds).toBe(40);
    // Sanitized URL, grouped by domain; not outside Chrome.
    expect(slot.domains).toEqual({ 'docs.example.com': 40 });
    expect(slot.urls).toEqual([{ url: 'https://docs.example.com/doc/1', seconds: 40 }]);
    expect(slot.outsideChromeSeconds).toBe(0);
    // Measurable page: only the second marked by the content script is active.
    expect(slot.activeSeconds).toBe(1);
  });

  it('does not measure without an open work day', async () => {
    await hello(h, 11);
    await activity(h, 11);
    await h.app.tracker.onIdleState('idle');
    expect(h.app.store.acc).toBeNull();
  });

  it('attributes time to the focused tab and follows tab switches', async () => {
    await hello(h, 11);
    await hello(h, 12);
    await h.app.session.start();
    await advance(20_000);
    const win = h.chrome.world.windows[0]!;
    win.tabs[0]!.active = false;
    win.tabs[1]!.active = true;
    await h.app.tracker.onTabActivated();
    await advance(10_000);
    await pulse(h);
    expect(current(h)!.domains).toEqual({ 'docs.example.com': 20, 'mail.example.org': 10 });
  });

  it('tabs.onUpdated of the active tab updates the URL and forgets measurability while loading', async () => {
    await hello(h, 11);
    await h.app.session.start();
    await advance(10_000);
    const tab = h.chrome.world.windows[0]!.tabs[0]!;
    tab.url = 'https://other.example.net/x';
    await h.app.tracker.onTabUpdated(11, { status: 'loading', url: tab.url }, { ...tab, windowId: 1 } as chrome.tabs.Tab);
    await advance(10_000);
    await pulse(h);
    const slot = current(h)!;
    expect(slot.domains).toEqual({ 'docs.example.com': 10, 'other.example.net': 10 });
    // Not measurable while loading (no hello yet) → idle 'active' counts as activity.
    expect(slot.activeSeconds).toBe(10);
  });

  it('idle and locked: no activity; locked counts as outside Chrome', async () => {
    await h.app.session.start(); // tab 11 without hello → not measurable
    await advance(10_000);
    await h.app.tracker.onIdleState('idle');
    await advance(10_000);
    await h.app.tracker.onIdleState('locked');
    h.chrome.world.idleState = 'locked';
    await advance(10_000);
    await pulse(h);
    const slot = current(h)!;
    expect(slot.trackedSeconds).toBe(30);
    expect(slot.activeSeconds).toBe(10); // only the first 10 s (active, page not measurable)
    expect(slot.outsideChromeSeconds).toBe(10); // locked
    expect(h.app.store.acc!.idleState).toBe('locked');
  });

  it('outside Chrome (WINDOW_ID_NONE): outsideChromeSeconds, activity from chrome.idle', async () => {
    await hello(h, 11);
    await h.app.session.start();
    await advance(10_000);
    h.chrome.world.windows[0]!.focused = false;
    await h.app.tracker.onWindowFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await advance(20_000);
    await pulse(h);
    const slot = current(h)!;
    expect(slot.outsideChromeSeconds).toBe(20);
    expect(slot.activeSeconds).toBe(20);
    expect(slot.domains).toEqual({ 'docs.example.com': 10 });
    // Coming back to Chrome.
    h.chrome.world.windows[0]!.focused = true;
    await h.app.tracker.onWindowFocusChanged(1);
    await advance(5_000);
    await pulse(h);
    expect(current(h)!.domains).toEqual({ 'docs.example.com': 15 });
  });

  it('non measurable pages (chrome://, no content script) fall back to chrome.idle', async () => {
    h.chrome.world.windows[0]!.tabs[0]!.url = 'chrome://newtab/';
    await h.app.session.start();
    await advance(15_000);
    await pulse(h);
    const slot = current(h)!;
    expect(slot.trackedSeconds).toBe(15);
    expect(slot.activeSeconds).toBe(15);
    expect(slot.domains).toEqual({});
    expect(slot.outsideChromeSeconds).toBe(0);
  });

  it('a hello from the active tab makes it measurable immediately', async () => {
    await h.app.session.start();
    await advance(10_000); // not measurable: idle-derived activity
    await hello(h, 11);
    await advance(10_000); // measurable, no input
    await pulse(h);
    expect(current(h)!.activeSeconds).toBe(10);
  });

  it('crossing a block boundary closes the block and queues it', async () => {
    vi.setSystemTime(SLOT0 + SLOT_MS - 20_000);
    await hello(h, 11);
    await h.app.session.start();
    await advance(20_000); // exactly at the boundary
    await advance(10_000);
    await pulse(h);
    const uid = h.app.store.session!.uid;
    const closed = h.backend.activity.get(activityDocId(uid, SLOT0));
    expect(closed?.trackedSeconds).toBe(20);
    expect(current(h)!.slotStart).toBe(SLOT0 + SLOT_MS);
    expect(current(h)!.trackedSeconds).toBe(10);
  });

  it('discards gaps longer than 90 s (worker/browser not running)', async () => {
    await hello(h, 11);
    await h.app.session.start();
    await advance(30_000);
    await pulse(h);
    vi.setSystemTime(Date.now() + 5 * 60_000); // no pulse for 5 min
    await pulse(h);
    await advance(30_000);
    await pulse(h);
    expect(current(h)!.trackedSeconds).toBe(60);
  });

  it('clamps activity timestamps from content scripts to the last 10 s', async () => {
    await hello(h, 11);
    await h.app.session.start();
    await advance(20_000);
    await activity(h, 11, Date.now() + 60 * 60_000); // bogus future → now
    await advance(1_000);
    await pulse(h);
    expect(current(h)!.activeSeconds).toBe(1);
  });

  it('ignores messages from sub-frames', async () => {
    await h.app.session.start();
    await h.app.tracker.onContentMessage({ type: 'hello' }, { ...h.chrome.senderFor(11), frameId: 3 });
    await advance(10_000);
    await pulse(h);
    expect(current(h)!.activeSeconds).toBe(10); // still not measurable
  });

  it('injects the content script into open tabs, ignoring pages that cannot be scripted', async () => {
    h.chrome.world.notScriptable.add(12);
    await h.app.injectContentScripts();
    expect(h.chrome.world.injected).toEqual([11]);
  });

  it('httpOrigin only accepts http(s)', () => {
    expect(httpOrigin('https://a.b/c?d')).toBe('https://a.b');
    expect(httpOrigin('chrome://newtab')).toBeNull();
    expect(httpOrigin(undefined)).toBeNull();
  });
});
