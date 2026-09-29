/**
 * Service-worker state persisted in `chrome.storage.local`.
 *
 * MV3 service workers are killed after ~30 s without events, so every wake-up
 * starts from scratch: the first `run()` reloads (rehydrates) the state.
 * All reads/writes go through `run()`, a promise-chain mutex, so concurrent
 * Chrome events (idle, tabs, alarms, messages) never interleave half-applied
 * changes or overwrite each other's writes.
 */
import { SlotAccumulator, type UserProfile } from '@timetracking/shared';
import { emptyQueue, queueFromJSON, type QueueState } from './queue';

export const STORAGE_KEYS = {
  acc: 'tt.acc',
  session: 'tt.session',
  queue: 'tt.queue',
  meta: 'tt.meta',
} as const;

export type StatePart = keyof typeof STORAGE_KEYS;

/** Work day open on this device. */
export interface LocalSession {
  id: string;
  uid: string;
  startedAt: number;
}

export interface JoinErrorInfo {
  reason: string;
  message: string;
}

export interface Meta {
  /** Last time the current block + heartbeat were queued (every ~60 s). */
  lastCurrentSyncAt: number;
  /** Last time the queue was fully uploaded. */
  lastSyncOkAt: number | null;
  /** Message for the popup (Spanish), e.g. "La jornada se cerró automáticamente". */
  notice: string | null;
  /** Profile returned by joinOrg for `profileUid`. */
  profile: UserProfile | null;
  profileUid: string | null;
  joinError: JoinErrorInfo | null;
}

export function defaultMeta(): Meta {
  return {
    lastCurrentSyncAt: 0,
    lastSyncOkAt: null,
    notice: null,
    profile: null,
    profileUid: null,
    joinError: null,
  };
}

/** Serializes async critical sections (FIFO). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive even when `fn` fails.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isLocalSession(v: unknown): v is LocalSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as LocalSession;
  return typeof s.id === 'string' && s.id !== '' && typeof s.uid === 'string' && typeof s.startedAt === 'number';
}

/** The subset of chrome.storage.StorageArea used here (easy to fake). */
export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface StateStoreOptions {
  area?: StorageAreaLike;
  /** Debounce of `markDirty('acc')` writes (activity marks arrive every second). */
  persistDelayMs?: number;
}

export class StateStore {
  acc: SlotAccumulator | null = null;
  session: LocalSession | null = null;
  queue: QueueState = emptyQueue();
  meta: Meta = defaultMeta();

  private readonly area: StorageAreaLike;
  private readonly persistDelayMs: number;
  private readonly mutex = new Mutex();
  private loading: Promise<void> | null = null;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: StateStoreOptions = {}) {
    this.area = opts.area ?? chrome.storage.local;
    this.persistDelayMs = opts.persistDelayMs ?? 2_000;
  }

  /** Runs `fn` exclusively, after the state has been loaded. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.mutex.run(async () => {
      await this.load();
      return fn();
    });
  }

  /** Loads (once per service-worker lifetime) the persisted state. */
  load(): Promise<void> {
    this.loading ??= this.doLoad().catch((err: unknown) => {
      this.loading = null; // retry on the next call
      throw err;
    });
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const data = await this.area.get(Object.values(STORAGE_KEYS));
    const rawAcc = data[STORAGE_KEYS.acc];
    this.acc = null;
    if (rawAcc) {
      try {
        this.acc = SlotAccumulator.fromJSON(rawAcc);
      } catch (err) {
        console.warn('[timetracking] acumulador ilegible, se descarta', err);
      }
    }
    const rawSession = data[STORAGE_KEYS.session];
    this.session = isLocalSession(rawSession) ? rawSession : null;
    this.queue = queueFromJSON(data[STORAGE_KEYS.queue]);
    const rawMeta = data[STORAGE_KEYS.meta];
    this.meta = { ...defaultMeta(), ...(rawMeta && typeof rawMeta === 'object' ? (rawMeta as Partial<Meta>) : {}) };
  }

  /**
   * Writes the given parts in a single `chrome.storage.local.set`. Call it
   * inside `run()`. Writing `acc` cancels a pending debounced write.
   */
  async save(...parts: StatePart[]): Promise<void> {
    const items: Record<string, unknown> = {};
    for (const part of parts) {
      switch (part) {
        case 'acc':
          items[STORAGE_KEYS.acc] = this.acc ? this.acc.toJSON() : null;
          this.clearDirty();
          break;
        case 'session':
          items[STORAGE_KEYS.session] = this.session;
          break;
        case 'queue':
          items[STORAGE_KEYS.queue] = this.queue;
          break;
        case 'meta':
          items[STORAGE_KEYS.meta] = this.meta;
          break;
      }
    }
    if (Object.keys(items).length > 0) await this.area.set(items);
  }

  /** Schedules a debounced write of the accumulator (used for 1/s activity marks). */
  markAccDirty(): void {
    if (this.dirtyTimer !== null) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      void this.run(() => this.save('acc')).catch((err: unknown) => {
        console.warn('[timetracking] no se pudo guardar el acumulador', err);
      });
    }, this.persistDelayMs);
  }

  private clearDirty(): void {
    if (this.dirtyTimer !== null) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
  }

  /** True when the accumulator still holds blocks not emitted as closed. */
  hasPendingSlots(): boolean {
    return this.acc !== null && this.acc.toJSON().slots.length > 0;
  }
}
