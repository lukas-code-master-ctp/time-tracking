import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_MS, activityDocId, slotStartOf, type ActivitySlot } from '@timetracking/shared';
import { backoffMs, emptyQueue, enqueueOp, opKey } from '../src/background/queue';
import { AUTO_CLOSED_NOTICE, PULSE_ALARM } from '../src/background/session';
import { STORAGE_KEYS, StateStore } from '../src/background/state';
import { classify, errorCode, toActivityDoc, toNewSessionDoc } from '../src/background/sync';
import { createHarness, hello, type Harness } from './fakes';

const SLOT0 = slotStartOf(1_790_000_000_000) + SLOT_MS;

function slot(partial: Partial<ActivitySlot> = {}): ActivitySlot {
  return {
    uid: 'u1',
    sessionId: 's1',
    slotStart: SLOT0,
    trackedSeconds: 10,
    activeSeconds: 5,
    outsideChromeSeconds: 0,
    domains: { 'a.com': 10 },
    urls: [{ url: 'https://a.com/', seconds: 10 }],
    ...partial,
  };
}

describe('documents sent to Firestore', () => {
  it('activity has exactly the 8 fields, integer and bounded counters', () => {
    const doc = toActivityDoc({
      ...slot({
        trackedSeconds: 700.4,
        activeSeconds: 800,
        outsideChromeSeconds: -3,
        domains: { 'docs.google.com': 12.6, '': 3, __name__: 1, 'zero.com': 0 },
        urls: Array.from({ length: 25 }, (_, i) => ({ url: `https://a.com/${i}`, seconds: 1.2 })),
      }),
      extra: 'nope',
    } as ActivitySlot);
    expect(Object.keys(doc).sort()).toEqual(
      ['activeSeconds', 'domains', 'outsideChromeSeconds', 'sessionId', 'slotStart', 'trackedSeconds', 'uid', 'urls'].sort(),
    );
    expect(doc.trackedSeconds).toBe(600);
    expect(doc.activeSeconds).toBe(600);
    expect(doc.outsideChromeSeconds).toBe(0);
    expect(doc.domains).toEqual({ 'docs.google.com': 13 });
    expect(doc.urls).toHaveLength(20);
    expect(doc.urls.every((u) => Number.isInteger(u.seconds))).toBe(true);
  });

  it('session is created with exactly the 5 fields, open', () => {
    expect(toNewSessionDoc('u1', 1_000.7)).toEqual({
      uid: 'u1',
      startedAt: 1001,
      endedAt: null,
      endReason: null,
      lastHeartbeatAt: 1001,
    });
  });
});

describe('queue', () => {
  it('coalesces: a newer snapshot of a block replaces the older one in place', () => {
    const q = emptyQueue();
    enqueueOp(q, { kind: 'activity', uid: 'u1', slot: slot({ trackedSeconds: 10 }) });
    enqueueOp(q, { kind: 'heartbeat', uid: 'u1', sessionId: 's1', at: 5 });
    enqueueOp(q, { kind: 'activity', uid: 'u1', slot: slot({ trackedSeconds: 20 }) });
    enqueueOp(q, { kind: 'heartbeat', uid: 'u1', sessionId: 's1', at: 9 });
    expect(q.items.map((i) => i.key)).toEqual([`activity:${activityDocId('u1', SLOT0)}`, 'heartbeat:s1']);
    expect(q.items[0]!.rev).toBe(2);
    expect(q.items[0]!.op).toMatchObject({ slot: { trackedSeconds: 20 } });
    expect(q.items[1]!.op).toMatchObject({ at: 9 });
    // Closing replaces pending heartbeats; later heartbeats are ignored.
    enqueueOp(q, { kind: 'sessionClose', uid: 'u1', sessionId: 's1', endedAt: 10 });
    enqueueOp(q, { kind: 'heartbeat', uid: 'u1', sessionId: 's1', at: 11 });
    expect(q.items.map((i) => i.key)).toEqual([opKey(q.items[0]!.op), 'close:s1']);
  });

  it('exponential backoff capped at 10 minutes', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffMs(30)).toBe(600_000);
  });

  it('classifies errors', () => {
    const hb = { kind: 'heartbeat', uid: 'u1', sessionId: 's1', at: 1 } as const;
    const act = { kind: 'activity', uid: 'u1', slot: slot() } as const;
    expect(classify('unavailable', hb, 50)).toBe('retry');
    expect(classify('permission-denied', hb, 0)).toBe('session-rejected');
    expect(classify('permission-denied', act, 0)).toBe('retry');
    expect(classify('permission-denied', act, 2)).toBe('drop');
    expect(classify('invalid-argument', act, 0)).toBe('drop');
    expect(errorCode({ code: 'firestore/unavailable' })).toBe('unavailable');
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('unavailable');
  });
});

describe('SyncEngine + SessionManager', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
    h = await createHarness();
    await hello(h, 11);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function pulse(): Promise<void> {
    await h.app.session.pulse();
    await h.settle();
  }

  it('start creates the session doc, pulses upload the block and heartbeat every ~60 s, stop closes it', async () => {
    const t0 = Date.now();
    await h.app.session.start();
    await h.settle();
    const sessionId = h.app.store.session!.id;
    expect(h.chrome.world.badgeText).toBe('ON');
    expect(h.chrome.world.alarms.get(PULSE_ALARM)?.periodInMinutes).toBe(0.5);
    expect(h.backend.ops('createSession')).toEqual([
      {
        op: 'createSession',
        sessionId,
        data: { uid: 'u1', startedAt: t0, endedAt: null, endReason: null, lastHeartbeatAt: t0 },
      },
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    await pulse(); // 30 s: nothing due yet
    expect(h.backend.ops('upsertActivity')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await pulse(); // 60 s: current block + heartbeat
    expect(h.backend.ops('upsertActivity')).toHaveLength(1);
    expect(h.backend.ops('heartbeat')).toEqual([{ op: 'heartbeat', sessionId, at: t0 + 60_000 }]);

    await vi.advanceTimersByTimeAsync(10_000);
    await h.app.session.stop();
    await h.settle();
    expect(h.chrome.world.badgeText).toBe('');
    const close = h.backend.ops('closeSession');
    expect(close).toEqual([{ op: 'closeSession', sessionId, endedAt: t0 + 70_000 }]);
    // The partial block went up right away with its final numbers.
    const docId = activityDocId('u1', SLOT0);
    expect(h.backend.activity.get(docId)?.trackedSeconds).toBe(70);
    expect(h.backend.sessions.get(sessionId)).toMatchObject({ endedAt: t0 + 70_000, endReason: 'manual' });

    // Keeps pulsing until the block closes, re-uploads it, then stops the alarm.
    expect(h.chrome.world.alarms.has(PULSE_ALARM)).toBe(true);
    const uploadsBefore = h.backend.ops('upsertActivity').length;
    vi.setSystemTime(SLOT0 + SLOT_MS + 1_000);
    await pulse();
    expect(h.backend.ops('upsertActivity').length).toBe(uploadsBefore + 1);
    expect(h.backend.activity.get(docId)?.trackedSeconds).toBe(70);
    expect(h.chrome.world.alarms.has(PULSE_ALARM)).toBe(false);
  });

  it('closed blocks are persisted in the queue BEFORE the accumulator', async () => {
    vi.setSystemTime(SLOT0 + SLOT_MS - 30_000);
    await h.app.session.start();
    await h.settle();
    h.backend.offline = true; // keep items in the queue
    h.chrome.local.setCalls = [];
    await vi.advanceTimersByTimeAsync(40_000); // cross the boundary
    await h.app.session.pulse();
    const docKey = `activity:${activityDocId('u1', SLOT0)}`;
    const calls = h.chrome.local.setCalls;
    const queueIdx = calls.findIndex((c) =>
      ((c[STORAGE_KEYS.queue] as { items?: { key: string }[] } | undefined)?.items ?? []).some((i) => i.key === docKey),
    );
    const accIdx = calls.findIndex((c) => {
      const acc = c[STORAGE_KEYS.acc] as { slots?: { slotStart: number }[] } | undefined;
      return acc !== undefined && !(acc.slots ?? []).some((s) => s.slotStart === SLOT0);
    });
    expect(queueIdx).toBeGreaterThanOrEqual(0);
    expect(accIdx).toBeGreaterThan(queueIdx);
    // Never a write where the block is in neither place.
    for (const c of calls.slice(0, accIdx)) expect(c[STORAGE_KEYS.acc]).toBeUndefined();
  });

  it('retries with exponential backoff while offline and drains when back online', async () => {
    h.backend.offline = true;
    await h.app.session.start();
    await h.settle();
    const q = h.app.store.queue;
    expect(q.items.map((i) => i.op.kind)).toEqual(['sessionCreate']);
    expect(q.failures).toBe(1);
    expect(q.retryAt).toBe(Date.now() + 5_000);

    // Within the backoff: no attempt.
    await h.app.sync.kick();
    expect(q.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await h.app.sync.kick();
    expect(h.app.store.queue.failures).toBe(2);
    expect(h.app.store.queue.retryAt).toBe(Date.now() + 10_000);

    // Offline for a while: blocks and heartbeats accumulate (coalesced).
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await pulse();
    }
    expect(h.backend.calls).toHaveLength(0);
    const kinds = h.app.store.queue.items.map((i) => i.op.kind);
    expect(kinds).toEqual(['sessionCreate', 'activity', 'heartbeat']);

    // The queue survives a service-worker restart.
    const app = await h.restart();
    expect(app.store.queue.items).toHaveLength(3);

    h.backend.offline = false;
    await app.sync.kick(true); // 'online' event
    await h.settle();
    expect(h.backend.calls.map((c) => c.op)).toEqual(['createSession', 'upsertActivity', 'heartbeat']);
    expect(app.store.queue.items).toHaveLength(0);
    expect(app.store.queue.failures).toBe(0);
    expect(app.store.meta.lastSyncOkAt).toBe(Date.now());
  });

  it('permission-denied on the heartbeat (auto-closed on the server) closes the work day locally, without retrying', async () => {
    await h.app.session.start();
    await h.settle();
    const sessionId = h.app.store.session!.id;
    h.backend.autoClose(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);
    await pulse();
    expect(h.app.store.session).toBeNull();
    expect(h.chrome.world.badgeText).toBe('');
    expect(h.app.store.meta.notice).toBe(AUTO_CLOSED_NOTICE);
    // No session operations left and no close attempt.
    expect(h.app.store.queue.items).toEqual([]);
    expect(h.backend.ops('closeSession')).toHaveLength(0);
    // The measured block is still uploaded (activity writes stay allowed).
    expect(h.backend.activity.get(activityDocId('u1', SLOT0))?.trackedSeconds).toBe(60);
    // Stopping afterwards is not possible (already closed), and nothing loops.
    await vi.advanceTimersByTimeAsync(30_000);
    await pulse();
    expect(h.backend.ops('heartbeat')).toHaveLength(0);
  });

  it('permission-denied when closing (already auto-closed) drops the operation', async () => {
    await h.app.session.start();
    await h.settle();
    const sessionId = h.app.store.session!.id;
    h.backend.autoClose(sessionId);
    await vi.advanceTimersByTimeAsync(10_000);
    await h.app.session.stop();
    await h.settle();
    expect(h.app.store.queue.items).toEqual([]);
    expect(h.app.store.queue.failures).toBe(0);
    expect(h.backend.sessions.get(sessionId)?.endReason).toBe('auto');
  });

  it('transient errors keep the operation; permanent ones drop it and continue', async () => {
    h.backend.failures = ['unavailable'];
    await h.app.session.start();
    await h.settle();
    expect(h.app.store.queue.items).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    h.backend.failures = [];
    await h.app.sync.kick();
    expect(h.backend.ops('createSession')).toHaveLength(1);

    // An activity rejected as invalid is dropped; the next operation still goes.
    h.backend.failures = ['invalid-argument'];
    await vi.advanceTimersByTimeAsync(60_000);
    await pulse();
    expect(h.app.store.queue.items).toEqual([]);
    expect(h.backend.ops('heartbeat')).toHaveLength(1);
  });

  it('operations of another user are dropped, not sent with the wrong account', async () => {
    await h.app.session.start();
    h.backend.uid = 'someone-else';
    await h.settle();
    expect(h.backend.calls).toHaveLength(0);
    expect(h.app.store.queue.items).toEqual([]);
  });

  it('without a signed-in user the queue waits (retry), it is not dropped', async () => {
    await h.app.session.start();
    h.backend.uid = null;
    await h.settle();
    expect(h.app.store.queue.items).toHaveLength(1);
    expect(h.app.store.queue.failures).toBeGreaterThan(0);
  });

  it('start requires a joined, active profile and only one open work day', async () => {
    await h.app.session.start();
    await expect(h.app.session.start()).rejects.toMatchObject({ reason: 'already-open' });
    await h.app.session.stop();
    h.app.store.meta.profile = { ...h.app.store.meta.profile!, status: 'disabled' };
    await expect(h.app.session.start()).rejects.toMatchObject({ reason: 'user-disabled' });
    h.app.store.meta.profile = null;
    await expect(h.app.session.start()).rejects.toMatchObject({ reason: 'not-joined' });
  });

  it('popup messages: status, start/stop and sign-out guard', async () => {
    const started = await h.app.handlePopup({ type: 'session.start' });
    expect(started.ok).toBe(true);
    expect(started.ok && started.status.session?.id).toBe(h.app.store.session!.id);
    const out = await h.app.handlePopup({ type: 'auth.signOut' });
    expect(out).toMatchObject({ ok: false, reason: 'session-open' });
    await h.app.handlePopup({ type: 'session.stop' });
    const ok = await h.app.handlePopup({ type: 'auth.signOut' });
    expect(ok.ok).toBe(true);
    expect(h.auth.signedOut).toBe(1);
    expect(ok.ok && ok.status.user).toBeNull();
  });

  it('routes runtime messages: extension pages get responses (even opened in a tab), content scripts feed the tracker', async () => {
    const popupSender = {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/popup.html',
      tab: { id: 99 } as chrome.tabs.Tab,
    };
    const response = await new Promise<unknown>((resolve) => {
      const keepOpen = h.chrome.events.message.dispatch({ type: 'status' }, popupSender, resolve);
      expect(keepOpen).toEqual([true]);
    });
    expect(response).toMatchObject({ ok: true, status: { appEnv: 'dev', session: null } });

    // A content script cannot drive the popup API.
    const fromPage = h.chrome.events.message.dispatch({ type: 'session.start' }, h.chrome.senderFor(11), () => {
      throw new Error('must not answer');
    });
    expect(fromPage).toEqual([false]);
    // Foreign extensions are ignored.
    expect(h.chrome.events.message.dispatch({ type: 'status' }, { ...popupSender, id: 'other' }, () => undefined)).toEqual([false]);
  });

  it('dev sign-in joins the organization and keeps the rejection reason', async () => {
    const { JoinError } = await import('../src/background/auth');
    h.auth.user = null;
    h.auth.joinResult = new JoinError('no-invitation', 'Pide a tu admin que te invite.');
    const res = await h.app.handlePopup({ type: 'auth.devSignIn', email: 'x@compratuparcela.cl' });
    expect(res.ok && res.status.profile).toBeNull();
    expect(res.ok && res.status.joinError).toEqual({ reason: 'no-invitation', message: 'Pide a tu admin que te invite.' });
  });

  it('state written by one worker is what the next worker uploads (no in-memory only data)', async () => {
    h.backend.offline = true;
    await h.app.session.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.app.session.pulse();
    const persisted = new StateStore({ area: h.chrome.local });
    await persisted.run(() => undefined);
    expect(persisted.queue.items.map((i) => i.op.kind)).toEqual(['sessionCreate', 'activity', 'heartbeat']);
  });
});
