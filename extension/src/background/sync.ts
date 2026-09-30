/**
 * Upload engine: drains the persistent queue (queue.ts) through a small
 * `Backend` interface (Firestore in production, a fake in unit tests).
 *
 * - FIFO, one operation at a time. A transient failure (offline, 503,
 *   no signed-in user…) stops the drain and schedules a retry with
 *   exponential backoff; the queue stays in chrome.storage.local, so nothing
 *   is lost if the service worker dies or the browser is closed.
 * - Permanent failures (invalid data) drop the operation.
 * - `permission-denied` on a session operation means the server no longer
 *   accepts writes to that work day: typically `autoCloseStaleSessions`
 *   already closed it (closed sessions are immutable in firestore.rules), or
 *   the user was disabled. The engine drops the session's operations and
 *   tells the session manager to close the work day locally. No endless
 *   retries.
 * - Data is normalized to exactly what firestore.rules accept (integer ms,
 *   exact field sets, counters within bounds).
 */
import {
  MAX_URLS_PER_SLOT,
  SLOT_SECONDS,
  activityDocId,
  type ActivitySlot,
  type Session,
} from '@timetracking/shared';
import { backoffMs, dropSessionOps, removeItem, type QueueItem, type SyncOp } from './queue';
import type { StateStore } from './state';

/** What the sync engine needs from Firebase. */
export interface Backend {
  /** uid of the signed-in user (waits for auth to be ready), or null. */
  currentUid(): Promise<string | null>;
  /** `setDoc(activity/{docId}, data, { merge: true })` — never dotted update paths (domain keys contain dots). */
  upsertActivity(docId: string, data: ActivitySlot): Promise<void>;
  /** `setDoc(sessions/{id}, data)` with the 5 fields of the model. */
  createSession(sessionId: string, data: Session): Promise<void>;
  /** `updateDoc(sessions/{id}, { lastHeartbeatAt })`. */
  heartbeat(sessionId: string, at: number): Promise<void>;
  /** `updateDoc(sessions/{id}, { endedAt, endReason: 'manual', lastHeartbeatAt: endedAt })`. */
  closeSession(sessionId: string, endedAt: number): Promise<void>;
}

/** Error with a Firebase-like code (`permission-denied`, `unavailable`…). */
export class BackendError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BackendError';
  }
}

/** Firebase error code of `err`, without the `firestore/` / `functions/` prefix. */
export function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const code = (err as { code: string }).code;
    const slash = code.indexOf('/');
    return slash >= 0 ? code.slice(slash + 1) : code;
  }
  // fetch() rejects with TypeError when the network is down.
  if (err instanceof TypeError) return 'unavailable';
  return 'unknown';
}

/** Codes worth retrying forever (with backoff): connectivity or auth not ready. */
const RETRY_FOREVER = new Set(['unavailable', 'deadline-exceeded', 'unauthenticated', 'resource-exhausted', 'aborted']);
/** Codes that will never succeed for the same payload. */
const PERMANENT = new Set([
  'invalid-argument',
  'failed-precondition',
  'not-found',
  'already-exists',
  'out-of-range',
  'data-loss',
  'unimplemented',
  'wrong-user',
]);
/** Max attempts for activity writes rejected by the rules (e.g. user disabled). */
export const MAX_ACTIVITY_DENIED_ATTEMPTS = 3;
/** Max attempts for unknown errors. */
export const MAX_UNKNOWN_ATTEMPTS = 8;

export type Outcome = 'ok' | 'retry' | 'drop' | 'session-rejected';

export function classify(code: string, op: SyncOp, attempts: number): Outcome {
  if (code === 'permission-denied') {
    if (op.kind === 'activity') return attempts + 1 >= MAX_ACTIVITY_DENIED_ATTEMPTS ? 'drop' : 'retry';
    return 'session-rejected';
  }
  if (PERMANENT.has(code)) return 'drop';
  if (RETRY_FOREVER.has(code)) return 'retry';
  return attempts + 1 >= MAX_UNKNOWN_ATTEMPTS ? 'drop' : 'retry';
}

const nonNegInt = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;

/**
 * The `activity` document exactly as firestore.rules expect it: the 8 fields
 * of the model plus `meetingSeconds`, integer counters,
 * activeSeconds/outsideChromeSeconds <= trackedSeconds <= 600,
 * activeSeconds + meetingSeconds <= trackedSeconds, at most 20 URLs, no
 * empty/reserved map keys.
 *
 * Decision: `meetingSeconds` is always sent (0 when there was no meeting).
 * Uploads are `set(..., { merge: true })`, so omitting it when 0 could leave a
 * stale value from an earlier snapshot of the same block; sending it always
 * keeps every snapshot self-contained. The rules also accept documents
 * without it (extension 0.1.1).
 */
export function toActivityDoc(slot: ActivitySlot): ActivitySlot {
  const trackedSeconds = Math.min(nonNegInt(slot.trackedSeconds), SLOT_SECONDS);
  const domains: Record<string, number> = {};
  for (const [domain, seconds] of Object.entries(slot.domains ?? {})) {
    const s = Math.min(nonNegInt(seconds), SLOT_SECONDS);
    if (domain !== '' && !/^__.*__$/.test(domain) && s > 0) domains[domain] = s;
  }
  const urls = (Array.isArray(slot.urls) ? slot.urls : [])
    .filter((u) => u && typeof u.url === 'string' && u.url !== '')
    .slice(0, MAX_URLS_PER_SLOT)
    .map((u) => ({ url: u.url, seconds: Math.min(nonNegInt(u.seconds), SLOT_SECONDS) }));
  const activeSeconds = Math.min(nonNegInt(slot.activeSeconds), trackedSeconds);
  return {
    uid: slot.uid,
    sessionId: slot.sessionId,
    slotStart: nonNegInt(slot.slotStart),
    trackedSeconds,
    activeSeconds,
    outsideChromeSeconds: Math.min(nonNegInt(slot.outsideChromeSeconds), trackedSeconds),
    meetingSeconds: Math.min(nonNegInt(slot.meetingSeconds), trackedSeconds - activeSeconds),
    domains,
    urls,
  };
}

/** The `sessions` document at creation: exactly the 5 fields, open. */
export function toNewSessionDoc(uid: string, startedAt: number): Session {
  const t = nonNegInt(startedAt);
  return { uid, startedAt: t, endedAt: null, endReason: null, lastHeartbeatAt: t };
}

export async function execOp(backend: Backend, op: SyncOp): Promise<void> {
  switch (op.kind) {
    case 'activity': {
      const doc = toActivityDoc(op.slot);
      // A block without session id (should not happen) would be rejected by the rules.
      if (!doc.sessionId) throw new BackendError('invalid-argument', 'activity sin sessionId');
      await backend.upsertActivity(activityDocId(doc.uid, doc.slotStart), doc);
      return;
    }
    case 'sessionCreate':
      await backend.createSession(op.sessionId, toNewSessionDoc(op.uid, op.session.startedAt));
      return;
    case 'heartbeat':
      await backend.heartbeat(op.sessionId, nonNegInt(op.at));
      return;
    case 'sessionClose':
      await backend.closeSession(op.sessionId, nonNegInt(op.endedAt));
      return;
  }
}

export interface SyncHooks {
  /** The server refused a session write: the work day is closed there. */
  onSessionRejected(sessionId: string): Promise<void>;
}

export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private forceNext = false;

  constructor(
    private readonly store: StateStore,
    private readonly backend: Backend,
    private readonly hooks: SyncHooks,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Uploads pending operations. `force` ignores the backoff (e.g. the network
   * came back, or the user pressed "sync"). Concurrent calls share one drain.
   */
  kick(force = false): Promise<void> {
    if (force) this.forceNext = true;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const f = this.forceNext;
          this.forceNext = false;
          await this.drain(f);
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async drain(force: boolean): Promise<void> {
    for (;;) {
      const next = await this.store.run<Pick<QueueItem, 'key' | 'rev' | 'op' | 'attempts'> | null>(() => {
        const q = this.store.queue;
        if (!force && q.retryAt > this.now()) return null;
        const head = q.items[0];
        return head ? { key: head.key, rev: head.rev, op: head.op, attempts: head.attempts } : null;
      });
      if (!next) return;
      force = false;

      let outcome: Outcome;
      let code = '';
      try {
        const uid = await this.backend.currentUid();
        if (uid === null) throw new BackendError('unauthenticated');
        if (uid !== next.op.uid) throw new BackendError('wrong-user', 'operación de otro usuario');
        await execOp(this.backend, next.op);
        outcome = 'ok';
      } catch (err) {
        code = errorCode(err);
        outcome = classify(code, next.op, next.attempts);
        if (outcome !== 'retry') console.warn(`[timetracking] ${next.key} descartada (${code})`, err);
      }

      const rejectedSession =
        outcome === 'session-rejected' && next.op.kind !== 'activity' ? next.op.sessionId : null;

      await this.store.run(async () => {
        const q = this.store.queue;
        const now = this.now();
        if (outcome === 'retry') {
          const item = q.items.find((i) => i.key === next.key && i.rev === next.rev);
          if (item) item.attempts += 1;
          q.failures += 1;
          q.retryAt = now + backoffMs(q.failures);
        } else {
          removeItem(q, next.key, next.rev);
          if (rejectedSession) dropSessionOps(q, rejectedSession);
          q.failures = 0;
          q.retryAt = 0;
          if (q.items.length === 0) this.store.meta.lastSyncOkAt = now;
        }
        await this.store.save('queue', 'meta');
      });

      if (rejectedSession) await this.hooks.onSessionRejected(rejectedSession);
      if (outcome === 'retry') return;
    }
  }
}
