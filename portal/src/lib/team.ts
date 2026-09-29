/**
 * Portal-specific shaping of the team data on top of shared `reports.ts`.
 */
import {
  MAX_SESSION_MS,
  isSessionLive,
  sessionDurationSeconds,
  summarizeTeam,
  type ActivitySlot,
  type Session,
  type TeamMember,
  type TeamSummary,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { formatTime, zonedDate } from './dates';

/**
 * How far before the range start a session may have started and still
 * overlap it. Sessions are closed automatically after 16 h (hourly job), so
 * 24 h is a safe margin; open sessions are queried separately (any start).
 */
export const SESSION_LOOKBACK_MS = MAX_SESSION_MS + 8 * 3_600_000;

/** Merges session lists by id (the same session may come from two queries). */
export function mergeSessions(...lists: readonly (readonly WithId<Session>[])[]): WithId<Session>[] {
  const byId = new Map<string, WithId<Session>>();
  for (const list of lists) for (const s of list) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** True when the session overlaps `[from, to)` (open sessions count until their last heartbeat). */
export function sessionOverlaps(session: Session, from: number, to: number): boolean {
  const end = session.endedAt ?? session.lastHeartbeatAt;
  return session.startedAt < to && end >= from;
}

/**
 * Team summary for the table. Disabled users are listed only when they have
 * data in the range (so past hours are not lost from the report).
 */
export function buildTeam(
  users: readonly WithId<UserProfile>[],
  slots: readonly ActivitySlot[],
  sessions: readonly WithId<Session>[],
  range: { from: number; to: number },
  now: number,
): TeamSummary {
  const members: TeamMember[] = users.map(({ id, ...u }) => ({ ...u, uid: id }));
  const team = summarizeTeam(members, slots, sessions, { from: range.from, to: range.to, now, topN: 5 });
  const rows = team.rows.filter((r) => r.status === 'active' || r.slotCount > 0 || r.sessionCount > 0);
  if (rows.length === team.rows.length) return team;
  // Recompute totals over the visible rows.
  return summarizeTeam(
    members.filter((m) => rows.some((r) => r.uid === m.uid)),
    slots,
    sessions,
    { from: range.from, to: range.to, now, topN: 5 },
  );
}

export type SessionState = 'live' | 'stale' | 'manual' | 'auto';

export interface SessionView {
  id: string;
  start: string;
  /** "En curso", or the end time. */
  end: string;
  durationSeconds: number;
  state: SessionState;
  /** Human reason / status. */
  note: string;
  /** Started on a previous day (shown as "desde el 28-09"). */
  startedBefore: boolean;
}

/** Rows of the "Jornadas del día" list, clipped to the day. */
export function sessionViews(
  sessions: readonly WithId<Session>[],
  day: { from: number; to: number },
  now: number,
  timeZone?: string,
): SessionView[] {
  return sessions
    .filter((s) => sessionOverlaps(s, day.from, day.to))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => {
      const live = isSessionLive(s, now);
      const state: SessionState = s.endedAt === null ? (live ? 'live' : 'stale') : s.endReason === 'auto' ? 'auto' : 'manual';
      const startedBefore = s.startedAt < day.from;
      const start = startedBefore
        ? `${formatTime(s.startedAt, timeZone)} (${zonedDate(s.startedAt, timeZone).split('-').reverse().slice(0, 2).join('-')})`
        : formatTime(s.startedAt, timeZone);
      const endMs = s.endedAt ?? s.lastHeartbeatAt;
      const end = state === 'live' ? 'En curso' : formatTime(endMs, timeZone);
      const note =
        state === 'live'
          ? 'Jornada abierta'
          : state === 'stale'
            ? `Sin señal desde las ${formatTime(s.lastHeartbeatAt, timeZone)}`
            : state === 'auto'
              ? 'Cerrada automáticamente'
              : 'Cerrada por el colaborador';
      return {
        id: s.id,
        start,
        end,
        durationSeconds: sessionDurationSeconds(s, day.from, day.to),
        state,
        note,
        startedBefore,
      };
    });
}

/**
 * Live refresh of a range that includes today. Re-reading a whole month every
 * minute costs ~30 000 Firestore reads per refresh for 30 people, so a
 * refresh re-reads only the blocks from `since` (start of today, or of the
 * previous refresh's day after midnight) and keeps the older ones already
 * loaded. "Actualizar" still does a full read (late uploads of past days).
 */
export function mergeActivity(
  previous: readonly ActivitySlot[],
  fresh: readonly ActivitySlot[],
  since: number,
): ActivitySlot[] {
  return [...previous.filter((s) => s.slotStart < since), ...fresh];
}
