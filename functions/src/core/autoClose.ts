/**
 * Automatic closing of work days (spec sections 3.6 and 6,
 * `autoCloseStaleSessions`).
 *
 * An open session (`endedAt == null`) is closed when its last heartbeat is
 * older than STALE_SESSION_MS or it has been open for longer than
 * MAX_SESSION_MS. It ends at its last heartbeat (never after
 * startedAt + MAX_SESSION_MS, never before startedAt), with `endReason: 'auto'`.
 */
import { FieldPath, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, MAX_SESSION_MS, STALE_SESSION_MS, type Session } from '@timetracking/shared';

export interface AutoCloseDecision {
  close: boolean;
  endedAt: number;
}

/** Pure decision for one open session. */
export function decideAutoClose(
  session: Pick<Session, 'startedAt' | 'lastHeartbeatAt'>,
  now: number,
): AutoCloseDecision {
  const startedAt = session.startedAt;
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

  let last: DocumentSnapshot | undefined;
  for (;;) {
    const page = await (last ? base.startAfter(last) : base).get();
    if (page.empty) break;
    last = page.docs[page.docs.length - 1];

    await Promise.all(
      page.docs.map(async (doc) => {
        const s = doc.data() as Session;
        if (typeof s.startedAt !== 'number') return;
        const decision = decideAutoClose(s, now);
        if (!decision.close) return;
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
