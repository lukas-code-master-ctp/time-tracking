/**
 * Persistent upload queue (pure data structure; the engine lives in sync.ts).
 *
 * Operations are coalesced by key, so the queue stays small even after days
 * offline and every operation is idempotent when replayed:
 * - activity: one item per block (`activityDocId`); a newer snapshot of the
 *   same block replaces the older one in place (a closed block supersedes the
 *   partial "current" snapshot).
 * - heartbeat: one item per session, the latest instant wins.
 * - sessionClose: removes pending heartbeats of the same session.
 * - sessionCreate: one per session.
 * Order is FIFO, so a session is created before its heartbeats and closed
 * after them.
 */
import { activityDocId, type ActivitySlot, type Session } from '@timetracking/shared';

export type SyncOp =
  | { kind: 'sessionCreate'; uid: string; sessionId: string; session: Session }
  | { kind: 'activity'; uid: string; slot: ActivitySlot }
  | { kind: 'heartbeat'; uid: string; sessionId: string; at: number }
  | { kind: 'sessionClose'; uid: string; sessionId: string; endedAt: number };

export interface QueueItem {
  /** Coalescing key, see {@link opKey}. */
  key: string;
  /** Bumped whenever the item is replaced, so an in-flight upload of an older revision does not remove the newer one. */
  rev: number;
  op: SyncOp;
  /** Failed attempts of this revision. */
  attempts: number;
}

export interface QueueState {
  items: QueueItem[];
  /** Consecutive transient failures (drives the exponential backoff). */
  failures: number;
  /** Do not retry before this instant (epoch ms); 0 = now. */
  retryAt: number;
}

export const MAX_QUEUE_ITEMS = 5000;
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

export function emptyQueue(): QueueState {
  return { items: [], failures: 0, retryAt: 0 };
}

export function opKey(op: SyncOp): string {
  switch (op.kind) {
    case 'activity':
      return `activity:${activityDocId(op.uid, op.slot.slotStart)}`;
    case 'heartbeat':
      return `heartbeat:${op.sessionId}`;
    case 'sessionClose':
      return `close:${op.sessionId}`;
    case 'sessionCreate':
      return `create:${op.sessionId}`;
  }
}

/** Adds (or coalesces) an operation. Mutates `q`. */
export function enqueueOp(q: QueueState, op: SyncOp): void {
  if (op.kind === 'heartbeat' && q.items.some((i) => i.key === `close:${op.sessionId}`)) {
    return; // the close already carries the final heartbeat
  }
  if (op.kind === 'sessionClose') {
    q.items = q.items.filter((i) => i.key !== `heartbeat:${op.sessionId}`);
  }
  const key = opKey(op);
  const existing = q.items.find((i) => i.key === key);
  if (existing) {
    if (op.kind === 'heartbeat' && existing.op.kind === 'heartbeat' && existing.op.at >= op.at) return;
    existing.op = op;
    existing.rev += 1;
    existing.attempts = 0;
    return;
  }
  q.items.push({ key, rev: 1, op, attempts: 0 });
  if (q.items.length > MAX_QUEUE_ITEMS) q.items.splice(0, q.items.length - MAX_QUEUE_ITEMS);
}

/** Removes the item if it still has revision `rev`. Returns true when removed. */
export function removeItem(q: QueueState, key: string, rev: number): boolean {
  const idx = q.items.findIndex((i) => i.key === key && i.rev === rev);
  if (idx < 0) return false;
  q.items.splice(idx, 1);
  return true;
}

/** Removes every session operation (create/heartbeat/close) of `sessionId`. */
export function dropSessionOps(q: QueueState, sessionId: string): void {
  q.items = q.items.filter(
    (i) => !(i.op.kind !== 'activity' && 'sessionId' in i.op && i.op.sessionId === sessionId),
  );
}

/** Delay after `failures` consecutive transient failures: 5 s, 10 s, 20 s… capped at 10 min. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** Validates data read back from chrome.storage. Invalid items are dropped. */
export function queueFromJSON(raw: unknown): QueueState {
  const q = emptyQueue();
  if (!raw || typeof raw !== 'object') return q;
  const r = raw as Partial<QueueState>;
  q.failures = typeof r.failures === 'number' && r.failures >= 0 ? r.failures : 0;
  q.retryAt = typeof r.retryAt === 'number' && r.retryAt >= 0 ? r.retryAt : 0;
  for (const item of Array.isArray(r.items) ? r.items : []) {
    if (!item || typeof item !== 'object') continue;
    const op = (item as QueueItem).op;
    if (!op || typeof op !== 'object' || typeof op.uid !== 'string') continue;
    if (!['activity', 'heartbeat', 'sessionClose', 'sessionCreate'].includes(op.kind)) continue;
    try {
      const key = opKey(op);
      q.items.push({
        key,
        rev: typeof item.rev === 'number' ? item.rev : 1,
        op,
        attempts: typeof item.attempts === 'number' ? item.attempts : 0,
      });
    } catch {
      // malformed op (e.g. invalid slotStart): drop it
    }
  }
  return q;
}
