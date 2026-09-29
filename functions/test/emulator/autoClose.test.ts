import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SESSION_MS, STALE_SESSION_MS, type Session } from '@timetracking/shared';
import { autoCloseStaleSessionsCore } from '../../src/core/autoClose.js';
import { NOW, clearFirestore, closeAdmin, db, getDoc, seed } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const open = (startedAt: number, lastHeartbeatAt: number, uid = 'alice'): Session => ({
  uid,
  startedAt,
  endedAt: null,
  endReason: null,
  lastHeartbeatAt,
});

beforeEach(async () => {
  await clearFirestore();
});

afterAll(async () => {
  await closeAdmin();
});

describe('autoCloseStaleSessionsCore', () => {
  it('closes stale and too-long sessions and leaves recent open and closed ones alone', async () => {
    const staleHb = NOW - STALE_SESSION_MS - MIN;
    const longStart = NOW - MAX_SESSION_MS - 2 * HOUR;
    const closed: Session = {
      uid: 'bob',
      startedAt: NOW - 20 * HOUR,
      endedAt: NOW - 19 * HOUR,
      endReason: 'manual',
      lastHeartbeatAt: NOW - 19 * HOUR,
    };
    await seed({
      'sessions/stale': open(NOW - 3 * HOUR, staleHb),
      'sessions/long': open(longStart, NOW - MIN, 'bob'),
      'sessions/recent': open(NOW - 2 * HOUR, NOW - 5 * MIN, 'carol'),
      'sessions/closed': closed,
    });

    const res = await autoCloseStaleSessionsCore({ db: db(), now: NOW });

    expect(res.closed.sort()).toEqual(['long', 'stale']);
    expect(res.conflicts).toEqual([]);
    expect(await getDoc('sessions/stale')).toEqual({ ...open(NOW - 3 * HOUR, staleHb), endedAt: staleHb, endReason: 'auto' });
    expect(await getDoc('sessions/long')).toMatchObject({
      endedAt: longStart + MAX_SESSION_MS,
      endReason: 'auto',
      lastHeartbeatAt: NOW - MIN,
    });
    expect(await getDoc('sessions/recent')).toEqual(open(NOW - 2 * HOUR, NOW - 5 * MIN, 'carol'));
    expect(await getDoc('sessions/closed')).toEqual(closed);
  });

  it('is a no-op on a second run', async () => {
    await seed({ 'sessions/stale': open(NOW - 3 * HOUR, NOW - 2 * HOUR) });
    await autoCloseStaleSessionsCore({ db: db(), now: NOW });
    const again = await autoCloseStaleSessionsCore({ db: db(), now: NOW + HOUR });
    expect(again.closed).toEqual([]);
  });

  it('pages through many open sessions', async () => {
    const docs: Record<string, Session> = {};
    for (let i = 0; i < 7; i++) docs[`sessions/s${i}`] = open(NOW - 5 * HOUR, NOW - 2 * HOUR, `u${i}`);
    docs['sessions/fresh'] = open(NOW - HOUR, NOW - MIN, 'fresh');
    await seed(docs);

    const res = await autoCloseStaleSessionsCore({ db: db(), now: NOW, pageSize: 3 });

    expect(res.closed).toHaveLength(7);
    const stillOpen = await db().collection('sessions').where('endedAt', '==', null).get();
    expect(stillOpen.docs.map((d) => d.id)).toEqual(['fresh']);
  });
});
