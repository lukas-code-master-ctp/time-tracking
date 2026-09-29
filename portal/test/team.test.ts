import { describe, expect, it } from 'vitest';
import type { Session, WithId } from '@timetracking/shared';
import { dayBounds } from '../src/lib/dates';
import { buildTeam, mergeActivity, mergeSessions, sessionOverlaps, sessionViews } from '../src/lib/team';
import { member, slot } from './fakes';

const M = 60_000;
const day = dayBounds('2026-09-29');
const at = (h: number, m = 0): number => day.from + h * 60 * M + m * M;
const NOW = at(15, 30);

function session(id: string, uid: string, startedAt: number, endedAt: number | null, extra: Partial<Session> = {}): WithId<Session> {
  return {
    id,
    uid,
    startedAt,
    endedAt,
    endReason: endedAt === null ? null : 'manual',
    lastHeartbeatAt: endedAt ?? NOW - M,
    ...extra,
  };
}

describe('sessions', () => {
  it('merges by id', () => {
    const a = session('a', 'u', at(8), at(9));
    const b = session('b', 'u', at(7), null);
    expect(mergeSessions([a, b], [b]).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('overlap includes sessions started before the range that end inside or are still open', () => {
    const before = session('x', 'u', day.from - 3 * 3_600_000, at(1));
    const open = session('y', 'u', day.from - 3 * 3_600_000, null);
    const ended = session('z', 'u', day.from - 5 * 3_600_000, day.from - 3_600_000);
    expect(sessionOverlaps(before, day.from, day.to)).toBe(true);
    expect(sessionOverlaps(open, day.from, day.to)).toBe(true);
    expect(sessionOverlaps(ended, day.from, day.to)).toBe(false);
  });

  it('session views: clipped duration, states and reasons', () => {
    const views = sessionViews(
      [
        session('live', 'u', at(14), null),
        session('auto', 'u', at(1), at(2), { endReason: 'auto' }),
        session('stale', 'u', at(3), null, { lastHeartbeatAt: at(4) }),
        session('prev', 'u', day.from - 2 * 3_600_000, at(0, 30)),
      ],
      day,
      NOW,
    );
    expect(views.map((v) => [v.id, v.state])).toEqual([
      ['prev', 'manual'],
      ['auto', 'auto'],
      ['stale', 'stale'],
      ['live', 'live'],
    ]);
    expect(views[0]).toMatchObject({ start: '22:00 (28-09)', end: '00:30', durationSeconds: 30 * 60, startedBefore: true });
    expect(views[1]).toMatchObject({ start: '01:00', end: '02:00', note: 'Cerrada automáticamente' });
    expect(views[2]).toMatchObject({ note: 'Sin señal desde las 04:00' });
    expect(views[3]).toMatchObject({ end: 'En curso', note: 'Jornada abierta' });
  });
});

describe('buildTeam', () => {
  it('summarizes by member; disabled members only when they have data', () => {
    const users = [member('ana', 'Ana'), member('beto', 'Beto'), member('caro', 'Caro', { status: 'disabled' }), member('dani', 'Dani', { status: 'disabled' })];
    const slots = [slot('ana', at(9), 600, 300), slot('ana', at(9, 10), 600, 600), slot('dani', at(10))];
    const sessions = [session('s1', 'ana', at(9), null), session('s2', 'dani', at(10), at(10, 10))];
    const team = buildTeam(users, slots, sessions, day, NOW);
    expect(team.rows.map((r) => r.uid)).toEqual(['ana', 'beto', 'dani']);
    const ana = team.rows[0]!;
    expect(ana).toMatchObject({ inSession: true, trackedSeconds: 1200, activityPercent: 75, sessionCount: 1 });
    expect(team.rows[1]).toMatchObject({ trackedSeconds: 0, activityPercent: null, inSession: false });
    expect(team.totals).toMatchObject({ members: 3, membersInSession: 1, trackedSeconds: 1800 });
  });
});

describe('mergeActivity', () => {
  it('keeps blocks before `since` and replaces the rest with the fresh read', () => {
    const prev = [slot('ana', at(9), 600, 100), slot('ana', at(10), 300, 100), slot('ana', at(11), 200, 100)];
    const fresh = [slot('ana', at(10), 600, 500), slot('ana', at(12), 600, 600)];
    const merged = mergeActivity(prev, fresh, at(10));
    expect(merged.map((s) => [s.slotStart, s.trackedSeconds])).toEqual([
      [at(9), 600],
      [at(10), 600],
      [at(12), 600],
    ]);
  });
});
