/**
 * Automatic closing of work days (spec sections 3.6 and 6,
 * `autoCloseStaleSessions`).
 *
 * An open session (`endedAt == null`) is closed when its last heartbeat is
 * older than STALE_SESSION_MS or it has been open for longer than
 * MAX_SESSION_MS. It ends at its last heartbeat (never after
 * startedAt + MAX_SESSION_MS, never before startedAt), with `endReason: 'auto'`.
 *
 * Kiosk work days (spec 2026-11-10-marcaciones, `source: 'kiosk'`) have no
 * heartbeat: they close only after MAX_SESSION_MS (forgotten exit), at the
 * end of that day's schedule (`forgottenExitEnd`).
 */
import { FieldPath, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  MAX_SESSION_MS,
  SCHEDULE_CONFIG_DOC_ID,
  STALE_SESSION_MS,
  effectiveWeek,
  forgottenExitEnd,
  readPersonSchedule,
  readScheduleConfig,
  type ScheduleConfig,
  type Session,
  type WeekSchedule,
} from '@timetracking/shared';

export interface AutoCloseDecision {
  close: boolean;
  endedAt: number;
}

/** Pure decision for one open session. `schedule`: the person's, for kiosk sessions. */
export function decideAutoClose(
  session: Pick<Session, 'startedAt' | 'lastHeartbeatAt' | 'source'>,
  now: number,
  schedule: { week: WeekSchedule | null; holidays: readonly string[] } = { week: null, holidays: [] },
): AutoCloseDecision {
  const startedAt = session.startedAt;
  if (session.source === 'kiosk') {
    return { close: startedAt < now - MAX_SESSION_MS, endedAt: forgottenExitEnd(session, schedule.week, schedule.holidays) };
  }
  const heartbeat =
    typeof session.lastHeartbeatAt === 'number' && Number.isFinite(session.lastHeartbeatAt)
      ? session.lastHeartbeatAt
      : startedAt;
  const stale = heartbeat < now - STALE_SESSION_MS;
  const tooLong = startedAt < now - MAX_SESSION_MS;
  const endedAt = Math.max(startedAt, Math.min(heartbeat, startedAt + MAX_SESSION_MS));
  return { close: stale || tooLong, endedAt };
}

export interface AutoCloseDeps {
  db: Firestore;
  now: number;
  pageSize?: number;
  logger?: { warn(message: string, data?: unknown): void };
}

export interface AutoCloseResult {
  closed: string[];
  /** Sessions that changed while we were closing them (skipped). */
  conflicts: string[];
}

export async function autoCloseStaleSessionsCore(deps: AutoCloseDeps): Promise<AutoCloseResult> {
  const { db, now } = deps;
  const pageSize = Math.min(Math.max(deps.pageSize ?? 200, 1), 500);
  const result: AutoCloseResult = { closed: [], conflicts: [] };

  const base = db
    .collection(COLLECTIONS.sessions)
    .where('endedAt', '==', null)
    .orderBy(FieldPath.documentId())
    .limit(pageSize);

  // Schedules, read only when a kiosk work day has to be closed.
  let general: Promise<ScheduleConfig | null> | null = null;
  const scheduleOf = async (uid: string) => {
    general ??= db.collection(COLLECTIONS.config).doc(SCHEDULE_CONFIG_DOC_ID).get().then((d) => readScheduleConfig(d.data()));
    const [config, person] = await Promise.all([general, db.collection(COLLECTIONS.schedules).doc(uid).get()]);
    return { week: effectiveWeek(config, readPersonSchedule(person.data())), holidays: config?.holidays ?? [] };
  };

  let last: DocumentSnapshot | undefined;
  for (;;) {
    const page = await (last ? base.startAfter(last) : base).get();
    if (page.empty) break;
    last = page.docs[page.docs.length - 1];

    await Promise.all(
      page.docs.map(async (doc) => {
        const s = doc.data() as Session;
        if (typeof s.startedAt !== 'number') return;
        let decision = decideAutoClose(s, now);
        if (!decision.close) return;
        if (s.source === 'kiosk') decision = decideAutoClose(s, now, await scheduleOf(s.uid));
        try {
          // Precondition: skip if the client heartbeat/closed it meanwhile.
          await doc.ref.update(
            { endedAt: decision.endedAt, endReason: 'auto' },
            { lastUpdateTime: doc.updateTime },
          );
          result.closed.push(doc.id);
        } catch (err) {
          result.conflicts.push(doc.id);
          deps.logger?.warn('La jornada cambió mientras se cerraba; se reintenta en la próxima ejecución', {
            id: doc.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    if (page.size < pageSize) break;
  }
  return result;
}
