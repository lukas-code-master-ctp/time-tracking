import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_MS, SlotAccumulator, slotStartOf } from '@timetracking/shared';
import { Mutex, STORAGE_KEYS, StateStore } from '../src/background/state';
import { PULSE_ALARM } from '../src/background/session';
import { MockStorageArea, installChrome } from './chromeMock';
import { createHarness, hello } from './fakes';

const SLOT0 = slotStartOf(1_790_000_000_000) + SLOT_MS;

describe('Mutex', () => {
  it('runs critical sections one at a time, in order, even when one fails', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const section = (name: string, ms: number, fail = false) =>
      m.run(async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}:end`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([section('a', 5), section('b', 1, true), section('c', 0)]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('StateStore', () => {
  beforeEach(() => {
    installChrome();
  });

  it('rehydrates accumulator, session, queue and meta from storage', async () => {
    const area = new MockStorageArea();
    const a = new StateStore({ area });
    await a.run(async () => {
      a.acc = new SlotAccumulator({ uid: 'u1' });
      a.acc.setSession('s1', SLOT0);
      a.acc.setFocus({ url: 'https://x.test/a', measurable: false }, SLOT0);
      a.acc.tick(SLOT0 + 30_000);
      a.session = { id: 's1', uid: 'u1', startedAt: SLOT0 };
      a.queue.items.push({
        key: 'heartbeat:s1',
        rev: 1,
        attempts: 0,
        op: { kind: 'heartbeat', uid: 'u1', sessionId: 's1', at: SLOT0 },
      });
      a.meta.lastCurrentSyncAt = 123;
      await a.save('acc', 'session', 'queue', 'meta');
    });

    // New service-worker instance.
    const b = new StateStore({ area });
    await b.run(() => undefined);
    expect(b.session).toEqual({ id: 's1', uid: 'u1', startedAt: SLOT0 });
    expect(b.acc?.sessionId).toBe('s1');
    expect(b.acc?.flush(SLOT0 + 30_000).current?.trackedSeconds).toBe(30);
    expect(b.queue.items).toHaveLength(1);
    expect(b.meta.lastCurrentSyncAt).toBe(123);
  });

  it('loads once per worker lifetime and tolerates corrupt data', async () => {
    const area = new MockStorageArea();
    area.data[STORAGE_KEYS.acc] = { v: 99 };
    area.data[STORAGE_KEYS.session] = { id: 42 };
    area.data[STORAGE_KEYS.queue] = { items: [{ op: { kind: 'nope', uid: 'u' } }, null] };
    const getSpy = vi.spyOn(area, 'get');
    const s = new StateStore({ area });
    await Promise.all([s.run(() => undefined), s.run(() => undefined)]);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(s.acc).toBeNull();
    expect(s.session).toBeNull();
    expect(s.queue.items).toEqual([]);
  });

  it('serializes concurrent writers: no lost update', async () => {
    const area = new MockStorageArea();
    const s = new StateStore({ area });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        s.run(async () => {
          const n = s.meta.lastCurrentSyncAt;
          await Promise.resolve();
          s.meta.lastCurrentSyncAt = n + 1;
          await s.save('meta');
        }),
      ),
    );
    const fresh = new StateStore({ area });
    await fresh.run(() => undefined);
    expect(fresh.meta.lastCurrentSyncAt).toBe(20);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SLOT0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces accumulator writes of activity marks', async () => {
      const area = new MockStorageArea();
      const s = new StateStore({ area, persistDelayMs: 2_000 });
      await s.run(() => {
        s.acc = new SlotAccumulator({ uid: 'u1' });
      });
      s.markAccDirty();
      s.markAccDirty();
      s.markAccDirty();
      expect(area.setCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(area.setCalls).toHaveLength(1);
      expect(area.data[STORAGE_KEYS.acc]).toMatchObject({ uid: 'u1' });
    });

    it('browser restart with an open work day: continues, badge ON, pulse alarm, gap not counted', async () => {
      vi.setSystemTime(SLOT0 + 10_000);
      const h = await createHarness();
      await hello(h, 11);
      await h.app.session.start();
      await vi.advanceTimersByTimeAsync(30_000);
      await h.app.session.pulse();
      await h.settle();
      const sessionId = h.app.store.session!.id;

      // Browser closed for 2 h: badge and alarms are gone, storage survives.
      h.chrome.world.badgeText = '';
      h.chrome.world.alarms.clear();
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
      const app = await h.restart();
      await h.settle();
      expect(app.store.session?.id).toBe(sessionId);
      expect(h.chrome.world.badgeText).toBe('ON');
      expect(h.chrome.world.alarms.has(PULSE_ALARM)).toBe(true);

      await app.tracker.onContentMessage({ type: 'hello' }, h.chrome.senderFor(11));
      await vi.advanceTimersByTimeAsync(30_000);
      await app.session.pulse();
      await h.settle();
      // The old block was closed with its 30 s; the new one only has the last 30 s.
      const uploaded = [...h.backend.activity.values()].sort((a, b) => a.slotStart - b.slotStart);
      expect(uploaded[0]!.trackedSeconds).toBe(30);
      const last = uploaded[uploaded.length - 1]!;
      expect(last.trackedSeconds).toBe(30);
      expect(h.backend.ops('heartbeat').length).toBeGreaterThan(0);
    });

    it('restart with an open work day but the user signed out closes it locally', async () => {
      const h = await createHarness();
      await h.app.session.start();
      h.auth.user = null;
      const app = await h.restart();
      await h.settle();
      expect(app.store.session).toBeNull();
      expect(h.chrome.world.badgeText).toBe('');
    });
  });
});
