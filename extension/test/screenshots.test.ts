import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALARM_PERIOD_MS, MAX_PENDING_SCREENSHOTS, SLOT_MS, dateKey, slotStartOf, type ScreenshotMeta } from '@timetracking/shared';
import { ORG_CONFIG_REFRESH_MS } from '../src/background/app';
import {
  MAX_SHOT_DENIED_ATTEMPTS,
  base64ToBytes,
  bytesToBase64,
  emptyShotQueue,
  enqueueShot,
  isCapturableUrl,
  isDue,
  planFor,
  shotDataKey,
  shotQueueFromJSON,
  toScreenshotDoc,
  type PendingShot,
} from '../src/background/screenshots';
import { PULSE_ALARM } from '../src/background/session';
import { STORAGE_KEYS } from '../src/background/state';
import { createHarness, hello, type Harness } from './fakes';

const SLOT0 = slotStartOf(1_790_000_000_000) + SLOT_MS;
const LATEST = SLOT0 + SLOT_MS - ALARM_PERIOD_MS;

function shot(id: string, takenAt: number): PendingShot {
  return {
    id,
    meta: {
      uid: 'u1',
      sessionId: 's1',
      takenAt,
      storagePath: `screenshots/u1/2026-09-29/${id}.jpg`,
      blurred: true,
      width: 10,
      height: 10,
    },
    uploaded: false,
    attempts: 0,
  };
}

describe('capture plan (random instant per block)', () => {
  it('draws an instant inside [now, block end - one pulse] and keeps it for the whole block', () => {
    const now = SLOT0 + 20_000;
    const a = planFor(null, now, () => 0);
    expect(a).toEqual({ slotStart: SLOT0, at: now, done: false });
    const b = planFor(null, now, () => 0.999_999_9);
    expect(b.at).toBeLessThan(LATEST);
    expect(b.at).toBeGreaterThan(LATEST - 1_000);
    const c = planFor(null, now, () => 0.5);
    expect(c.at).toBe(now + Math.floor(0.5 * (LATEST - now)));
    // Same block: the stored plan wins (no redraw), whatever random() says.
    expect(planFor(c, now + 200_000, () => 0)).toBe(c);
    // Next block: new plan.
    expect(planFor(c, SLOT0 + SLOT_MS + 5_000, () => 0).slotStart).toBe(SLOT0 + SLOT_MS);
  });

  it('seen for the first time in the last pulse of the block → right away', () => {
    const now = LATEST + 10_000;
    expect(planFor(null, now, () => 0.7).at).toBe(now);
  });

  it('is due from its instant until the block ends, once', () => {
    const p = { slotStart: SLOT0, at: SLOT0 + 100_000, done: false };
    expect(isDue(p, SLOT0 + 99_999)).toBe(false);
    expect(isDue(p, SLOT0 + 100_000)).toBe(true);
    expect(isDue(p, SLOT0 + SLOT_MS)).toBe(false);
    expect(isDue({ ...p, done: true }, SLOT0 + 200_000)).toBe(false);
  });

  it('only http(s) pages can be captured', () => {
    expect(isCapturableUrl('https://a.com/x')).toBe(true);
    expect(isCapturableUrl('http://127.0.0.1:3000/')).toBe(true);
    for (const u of ['chrome://newtab/', 'chrome-extension://x/popup.html', 'file:///C:/a.pdf', '', undefined, 'nope']) {
      expect(isCapturableUrl(u)).toBe(false);
    }
  });
});

describe('screenshot queue (pure)', () => {
  it('keeps at most MAX_PENDING_SCREENSHOTS, dropping the oldest', () => {
    const q = emptyShotQueue();
    const dropped: string[] = [];
    for (let i = 0; i < MAX_PENDING_SCREENSHOTS + 3; i++) dropped.push(...enqueueShot(q, shot(`u1_${i}`, 1_000 + i)).dropped);
    expect(dropped).toEqual(['u1_0', 'u1_1', 'u1_2']);
    expect(q.items).toHaveLength(MAX_PENDING_SCREENSHOTS);
    expect(q.items[0]!.id).toBe('u1_3');
    expect(q.items.at(-1)!.id).toBe(`u1_${MAX_PENDING_SCREENSHOTS + 2}`);
  });

  it('the same block id is queued once (idempotent)', () => {
    const q = emptyShotQueue();
    expect(enqueueShot(q, shot('u1_1', 5))).toEqual({ added: true, dropped: [] });
    expect(enqueueShot(q, shot('u1_1', 6))).toEqual({ added: false, dropped: [] });
    expect(q.items).toHaveLength(1);
    expect(q.items[0]!.meta.takenAt).toBe(5);
  });

  it('validates what comes back from chrome.storage', () => {
    const q = shotQueueFromJSON({
      failures: 2,
      retryAt: 10,
      items: [shot('ok', 1), { id: 'bad' }, null, { ...shot('nometa', 2), meta: { uid: 1 } }, { ...shot('up', 3), uploaded: true }],
    });
    expect(q.items.map((i) => [i.id, i.uploaded])).toEqual([
      ['ok', false],
      ['up', true],
    ]);
    expect(q.failures).toBe(2);
    expect(shotQueueFromJSON('garbage')).toEqual(emptyShotQueue());
  });

  it('base64 round trip of binary JPEG data', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 37) % 256);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('the metadata doc has exactly the 7 fields of the rules, integers', () => {
    const doc = toScreenshotDoc({ ...shot('x', 1.6).meta, width: 10.2, extra: 1 } as ScreenshotMeta);
    expect(Object.keys(doc).sort()).toEqual(['blurred', 'height', 'sessionId', 'storagePath', 'takenAt', 'uid', 'width']);
    expect(doc.takenAt).toBe(2);
    expect(doc.width).toBe(10);
  });
});

describe('ScreenshotManager in the pulse', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
    h = await createHarness();
    await hello(h, 11);
    h.backend.org = { ...h.backend.org!, screenshotsEnabled: true, blurScreenshots: true };
    h.random.value = 0.5;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startDay(): Promise<void> {
    const res = await h.app.handlePopup({ type: 'session.start' });
    expect(res.ok).toBe(true);
    await h.app.refreshOrgConfig(0);
    await h.settle();
  }

  /** Pulses every 30 s until `until`. Returns the capture outcomes. */
  async function pulseUntil(until: number): Promise<string[]> {
    const out: string[] = [];
    while (Date.now() + 30_000 <= until) {
      await vi.advanceTimersByTimeAsync(30_000);
      out.push(await h.app.pulse());
      await h.settle();
    }
    return out;
  }

  it('one capture per block at the planned instant; file then the doc with the 7 fields', async () => {
    await startDay();
    const outcomes = await pulseUntil(SLOT0 + SLOT_MS - 1);
    expect(outcomes.filter((o) => o === 'captured')).toHaveLength(1);
    const plan = h.app.store.shotPlan!;
    expect(plan.slotStart).toBe(SLOT0);
    expect(plan.done).toBe(true);
    // The instant came from random() = 0.5 at the first pulse of the block.
    const firstPulse = SLOT0 + 90_000;
    expect(plan.at).toBe(firstPulse + Math.floor(0.5 * (LATEST - firstPulse)));
    expect(h.capturer.captures).toHaveLength(1);
    expect(h.images.calls).toEqual([{ blur: true }]);

    const id = `u1_${SLOT0}`;
    const meta = h.backend.screenshots.get(id)!;
    expect(Object.keys(meta).sort()).toEqual(['blurred', 'height', 'sessionId', 'storagePath', 'takenAt', 'uid', 'width']);
    expect(meta).toMatchObject({ uid: 'u1', sessionId: h.app.store.session!.id, blurred: true, width: 1280, height: 720 });
    expect(meta.storagePath).toBe(`screenshots/u1/${dateKey(meta.takenAt)}/${id}.jpg`);
    expect(h.backend.files.get(meta.storagePath)).toBe(7);
    expect(h.app.store.shots.items).toEqual([]);
    // Upload before doc.
    const order = h.backend.calls.filter((c) => c.op === 'uploadScreenshot' || c.op === 'putScreenshotMeta').map((c) => c.op);
    expect(order).toEqual(['uploadScreenshot', 'putScreenshotMeta']);

    // Next block: another one.
    await pulseUntil(SLOT0 + 2 * SLOT_MS - 1);
    expect(h.backend.screenshots.size).toBe(2);
    expect(h.backend.screenshots.has(`u1_${SLOT0 + SLOT_MS}`)).toBe(true);
  });

  it('the planned instant is persisted: a worker restart keeps it (no redraw)', async () => {
    await startDay();
    await vi.advanceTimersByTimeAsync(30_000);
    await h.app.pulse();
    const plan = { ...h.app.store.shotPlan! };
    expect(h.chrome.local.data[STORAGE_KEYS.shotPlan]).toEqual(plan);
    expect(plan.at).toBeGreaterThan(Date.now());

    await h.restart();
    h.random.value = 0; // a redraw would pick "now"
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await h.app.pulse()).toBe('not-due');
    expect(h.app.store.shotPlan).toEqual(plan);
    const outcomes = await pulseUntil(plan.at + 30_000);
    expect(outcomes.filter((o) => o === 'captured')).toHaveLength(1);
    expect(h.capturer.captures).toHaveLength(1);
  });

  it('no capture (and nothing recorded) without work day, with screenshots disabled, outside Chrome or on non-http pages', async () => {
    // No work day.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await h.app.screenshots.maybeCapture(true)).toBe('no-session');

    await startDay();
    // Outside Chrome / chrome:// page: the capturer finds no target.
    h.capturer.none = true;
    expect(await h.app.screenshots.maybeCapture(true)).toBe('no-target');
    h.capturer.none = false;
    // captureVisibleTab refused (page changed to chrome:// meanwhile).
    h.capturer.fail = true;
    expect(await h.app.screenshots.maybeCapture(true)).toBe('failed');
    h.capturer.fail = false;
    // One attempt per block: the next pulses of the same block do nothing.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await h.app.pulse()).toBe('not-due');

    // Disabled by the admin.
    h.backend.org = { ...h.backend.org!, screenshotsEnabled: false };
    await h.app.refreshOrgConfig(0);
    expect(await h.app.screenshots.maybeCapture(true)).toBe('disabled');

    expect(h.app.store.shots.items).toEqual([]);
    expect(h.backend.screenshots.size).toBe(0);
    expect(h.capturer.captures).toHaveLength(0);
  });

  it('without blur the image is processed and recorded as not blurred', async () => {
    h.backend.org = { ...h.backend.org!, blurScreenshots: false };
    await startDay();
    expect(await h.app.pulse({ forceScreenshot: true })).toBe('captured');
    await h.settle();
    expect(h.images.calls).toEqual([{ blur: false }]);
    expect(h.backend.screenshots.get(`u1_${SLOT0}`)?.blurred).toBe(false);
    // Even forced, never a second screenshot of the same block.
    expect(await h.app.pulse({ forceScreenshot: true })).toBe('duplicate');
    expect(h.capturer.captures).toHaveLength(1);
  });

  it('retry of a file that already exists in Storage counts as uploaded (no overwrite), then writes the doc', async () => {
    await startDay();
    expect(await h.app.screenshots.maybeCapture(true)).toBe('captured');
    const item = h.app.store.shots.items[0]!;
    // A previous attempt uploaded the file, but the worker died before recording it.
    h.backend.files.set(item.meta.storagePath, 7);
    await h.app.screenshots.drain(true);
    expect(h.backend.ops('uploadScreenshot')).toHaveLength(0);
    expect(h.backend.ops('screenshotExists')).toEqual([{ op: 'screenshotExists', path: item.meta.storagePath }]);
    expect(h.backend.screenshots.get(item.id)).toEqual(item.meta);
    expect(h.app.store.shots.items).toEqual([]);
  });

  it('the file is not uploaded twice when only the doc failed (transient)', async () => {
    await startDay();
    await h.app.screenshots.maybeCapture(true);
    h.backend.failures = ['', 'unavailable']; // upload ok, doc fails
    await h.app.screenshots.drain(true);
    expect(h.app.store.shots.items[0]).toMatchObject({ uploaded: true, attempts: 1 });
    expect(h.chrome.local.data[STORAGE_KEYS.shots]).toMatchObject({ items: [{ uploaded: true }] });
    await h.app.screenshots.drain(true);
    expect(h.backend.ops('uploadScreenshot')).toHaveLength(1);
    expect(h.backend.ops('putScreenshotMeta')).toHaveLength(1);
    expect(h.app.store.shots.items).toEqual([]);
  });

  it('offline: kept in the persistent queue (max 20, oldest dropped) and the alarm keeps running', async () => {
    await startDay();
    h.backend.offline = true;
    for (let i = 0; i < MAX_PENDING_SCREENSHOTS + 2; i++) {
      vi.setSystemTime(SLOT0 + (i + 1) * SLOT_MS + 1_000);
      expect(await h.app.pulse({ forceScreenshot: true })).toBe('captured');
    }
    const q = h.app.store.shots;
    expect(q.items).toHaveLength(MAX_PENDING_SCREENSHOTS);
    expect(q.items[0]!.id).toBe(`u1_${SLOT0 + 3 * SLOT_MS}`);
    expect(q.failures).toBeGreaterThan(0);
    expect((await h.app.status()).pendingScreenshots).toBe(MAX_PENDING_SCREENSHOTS);
    // One key per image; the index holds no image data; dropped ones are removed.
    const keys = Object.keys(h.chrome.local.data).filter((k) => k.startsWith('tt.shot.'));
    expect(keys.sort()).toEqual(q.items.map((i) => shotDataKey(i.id)).sort());
    expect(JSON.stringify(h.chrome.local.data[STORAGE_KEYS.shots]).length).toBeLessThan(10_000);

    await h.app.session.stop();
    h.backend.offline = false;
    h.backend.failures = [];
    vi.setSystemTime(Date.now() + SLOT_MS);
    await h.app.handlePopup({ type: 'sync.now' });
    await h.settle();
    expect(h.backend.screenshots.size).toBe(MAX_PENDING_SCREENSHOTS);
    expect(h.app.store.shots.items).toEqual([]);
    expect(Object.keys(h.chrome.local.data).filter((k) => k.startsWith('tt.shot.'))).toEqual([]);
    await h.app.pulse();
    expect(h.chrome.world.alarms.has(PULSE_ALARM)).toBe(false);
  });

  it('permission-denied for a file that is not there (user disabled) is retried a few times, then dropped', async () => {
    await startDay();
    await h.app.screenshots.maybeCapture(true);
    h.backend.denyUploads = true;
    for (let i = 0; i < MAX_SHOT_DENIED_ATTEMPTS - 1; i++) {
      await h.app.screenshots.drain(true);
      expect(h.app.store.shots.items[0]?.attempts).toBe(i + 1);
    }
    await h.app.screenshots.drain(true);
    expect(h.backend.ops('screenshotExists')).toHaveLength(MAX_SHOT_DENIED_ATTEMPTS);
    expect(h.app.store.shots.items).toEqual([]);
    expect(h.backend.screenshots.size).toBe(0);
  });

  it('screenshots of another user are dropped, never uploaded with the wrong account', async () => {
    await startDay();
    await h.app.screenshots.maybeCapture(true);
    h.backend.uid = 'someone-else';
    await h.app.screenshots.drain(true);
    expect(h.app.store.shots.items).toEqual([]);
    expect(h.backend.files.size).toBe(0);
  });
  it('the image survives a worker restart in its own key and is uploaded as captured', async () => {
    await startDay();
    h.backend.offline = true;
    expect(await h.app.screenshots.maybeCapture(true)).toBe('captured');
    const id = h.app.store.shots.items[0]!.id;
    expect(typeof h.chrome.local.data[shotDataKey(id)]).toBe('string');
    await h.restart();
    h.backend.offline = false;
    h.backend.failures = [];
    await h.app.screenshots.drain(true);
    expect(h.backend.files.get(h.backend.screenshots.get(id)!.storagePath)).toBe(7);
    expect(h.chrome.local.data[shotDataKey(id)]).toBeUndefined();
  });

  it('a screenshot whose image key is missing is dropped (nothing uploaded)', async () => {
    await startDay();
    await h.app.screenshots.maybeCapture(true);
    const id = h.app.store.shots.items[0]!.id;
    delete h.chrome.local.data[shotDataKey(id)];
    await h.app.screenshots.drain(true);
    expect(h.app.store.shots.items).toEqual([]);
    expect(h.backend.files.size).toBe(0);
  });

  it('never queued if the work day closed while capturing', async () => {
    await startDay();
    const orig = h.capturer.capture.bind(h.capturer);
    h.capturer.capture = async (w) => {
      const r = await orig(w);
      await h.app.session.stop();
      return r;
    };
    expect(await h.app.screenshots.maybeCapture(true)).toBe('no-session');
    expect(h.app.store.shots.items).toEqual([]);
    expect(Object.keys(h.chrome.local.data).filter((k) => k.startsWith('tt.shot.'))).toEqual([]);
  });

  it('a sharp image is never kept when blurring is required', async () => {
    await startDay();
    h.images.process = async () => ({ bytes: new Uint8Array([1]), width: 10, height: 10, blurred: false });
    expect(await h.app.screenshots.maybeCapture(true)).toBe('failed');
    expect(h.app.store.shots.items).toEqual([]);
  });

});

describe('config/org cache', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('read on start of the work day, then at most every 5 minutes from the pulse; shown in the status', async () => {
    const before = h.backend.orgFetches;
    await h.app.handlePopup({ type: 'session.start' });
    await h.settle();
    expect(h.backend.orgFetches).toBe(before + 1);
    expect((await h.app.status()).capture).toEqual({ screenshots: false, blur: true });

    h.backend.org = { ...h.backend.org!, screenshotsEnabled: true };
    await vi.advanceTimersByTimeAsync(30_000);
    await h.app.pulse();
    expect(h.backend.orgFetches).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(ORG_CONFIG_REFRESH_MS);
    await h.app.pulse();
    expect(h.backend.orgFetches).toBe(before + 2);
    expect((await h.app.status()).capture).toEqual({ screenshots: true, blur: true });
    expect(h.chrome.local.data[STORAGE_KEYS.meta]).toMatchObject({ org: { uid: 'u1', screenshotsEnabled: true } });
  });

  it('a failed read keeps the cache; a missing doc means no screenshots', async () => {
    h.backend.org = { ...h.backend.org!, screenshotsEnabled: true };
    await h.app.refreshOrgConfig(0);
    h.backend.offline = true;
    await h.app.refreshOrgConfig(0);
    expect((await h.app.status()).capture?.screenshots).toBe(true);
    h.backend.offline = false;
    h.backend.org = null;
    await h.app.refreshOrgConfig(0);
    expect((await h.app.status()).capture).toEqual({ screenshots: false, blur: true });
  });

  it('not read without a joined profile (rules: active users only)', async () => {
    const g = await createHarness({ joined: false });
    await g.app.refreshOrgConfig(0);
    expect(g.backend.orgFetches).toBe(0);
    expect((await g.app.status()).capture).toBeNull();
  });

});
