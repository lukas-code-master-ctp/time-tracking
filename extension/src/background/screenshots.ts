/**
 * Screenshots (spec 3.3): at most one per 10-minute block, at a random
 * instant inside the block, of the visible tab only.
 *
 * - Plan: when a pulse first sees a block, it draws a random instant in
 *   [now, blockEnd - 30 s] (so the 30-second pulse cannot skip it) and
 *   persists it (`tt.shotPlan`), so the instant survives the service worker
 *   sleeping. The first pulse at or after that instant decides: there is one
 *   attempt per block.
 * - Conditions at that instant: open work day, `screenshotsEnabled` in the
 *   cached `config/org`, a focused (non-incognito) Chrome window whose active
 *   tab is http/https, screen not locked. Otherwise nothing is captured and
 *   nothing is recorded (the data model has no "no screenshot" field; see the
 *   spec's decisions).
 * - Capture: `chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg' })`,
 *   then resize/blur/encode below 1 MB (image.ts, OffscreenCanvas).
 * - Queue: persistent, max MAX_PENDING_SCREENSHOTS (the oldest are dropped).
 *   `tt.shots` only holds the small index (metadata, attempts); each JPEG
 *   (base64) lives in its own key `tt.shot.<id>` ({@link shotDataKey}), so
 *   loading the state on every wake-up and each queue update never read or
 *   rewrite up to 20 images: the data key is written once and read only when
 *   that screenshot is uploaded. Deterministic id `${uid}_${slotStart}`, so retries
 *   are idempotent: Storage never overwrites (rules), so a failed re-upload
 *   of an object that already exists counts as uploaded (checked with a
 *   metadata GET); the `screenshots/{id}` doc is written after the file with
 *   exactly the 7 fields of the rules (re-writing identical data is allowed).
 */
import {
  ALARM_PERIOD_MS,
  IDLE_DETECTION_SECONDS,
  MAX_PENDING_SCREENSHOTS,
  SLOT_MS,
  screenshotStoragePath,
  slotStartOf,
  type ScreenshotMeta,
} from '@timetracking/shared';
import type { ImageProcessor } from './image';
import { backoffMs } from './queue';
import type { Remote } from './remote';
import type { StateStore } from './state';
import { errorCode } from './sync';

// ---------- plan (pure) ----------

export interface ShotPlan {
  slotStart: number;
  /** Chosen instant (epoch ms) inside the block. */
  at: number;
  /** The attempt of this block already happened (captured or not). */
  done: boolean;
  /** A screenshot of this block was queued (never a second one, even when forced). */
  taken?: boolean;
}

/**
 * Plan of the block containing `now`: the existing one if it is for that
 * block, otherwise a new random instant in [now, blockEnd - one pulse].
 */
export function planFor(prev: ShotPlan | null, now: number, random: () => number = Math.random): ShotPlan {
  const slotStart = slotStartOf(now);
  if (prev && prev.slotStart === slotStart) return prev;
  const latest = slotStart + SLOT_MS - ALARM_PERIOD_MS;
  const from = Math.max(now, slotStart);
  const span = latest - from;
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  const at = span > 0 ? from + Math.floor(r * span) : from;
  return { slotStart, at, done: false };
}

export function isDue(plan: ShotPlan, now: number): boolean {
  return !plan.done && now >= plan.at && now < plan.slotStart + SLOT_MS;
}

export function shotPlanFromJSON(raw: unknown): ShotPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<ShotPlan>;
  if (typeof p.slotStart !== 'number' || typeof p.at !== 'number' || typeof p.done !== 'boolean') return null;
  return { slotStart: p.slotStart, at: p.at, done: p.done, ...(p.taken === true ? { taken: true } : {}) };
}

// ---------- queue (pure) ----------

export interface PendingShot {
  /** `${uid}_${slotStart}`: doc id and file name. The JPEG is in {@link shotDataKey}(id). */
  id: string;
  meta: ScreenshotMeta;
  /** The file is already in Storage; only the doc is missing. */
  uploaded: boolean;
  attempts: number;
}

export interface ShotQueue {
  items: PendingShot[];
  failures: number;
  retryAt: number;
}

export function emptyShotQueue(): ShotQueue {
  return { items: [], failures: 0, retryAt: 0 };
}

export function screenshotId(uid: string, slotStart: number): string {
  return `${uid}_${slotStart}`;
}

/** `chrome.storage.local` key of the JPEG (base64) of a queued screenshot. */
export function shotDataKey(id: string): string {
  return `tt.shot.${id}`;
}

/**
 * Adds a screenshot (ignored if its id is already queued). Drops the oldest
 * beyond the limit. Mutates `q`; returns whether it was added and the ids
 * dropped (their data keys must be removed).
 */
export function enqueueShot(
  q: ShotQueue,
  shot: PendingShot,
  max: number = MAX_PENDING_SCREENSHOTS,
): { added: boolean; dropped: string[] } {
  if (q.items.some((i) => i.id === shot.id)) return { added: false, dropped: [] };
  q.items.push(shot);
  q.items.sort((a, b) => a.meta.takenAt - b.meta.takenAt);
  const dropped = q.items.length > max ? q.items.splice(0, q.items.length - max).map((i) => i.id) : [];
  return { added: !dropped.includes(shot.id), dropped };
}

const META_KEYS = ['uid', 'sessionId', 'takenAt', 'storagePath', 'blurred', 'width', 'height'] as const;

function isMeta(m: unknown): m is ScreenshotMeta {
  if (!m || typeof m !== 'object') return false;
  const x = m as ScreenshotMeta;
  return (
    typeof x.uid === 'string' &&
    typeof x.sessionId === 'string' &&
    typeof x.takenAt === 'number' &&
    typeof x.storagePath === 'string' &&
    typeof x.blurred === 'boolean' &&
    typeof x.width === 'number' &&
    typeof x.height === 'number'
  );
}

/** Exactly the 7 fields of firestore.rules, integers. */
export function toScreenshotDoc(m: ScreenshotMeta): ScreenshotMeta {
  const out = {} as Record<string, unknown>;
  for (const k of META_KEYS) out[k] = m[k];
  const doc = out as unknown as ScreenshotMeta;
  doc.takenAt = Math.round(doc.takenAt);
  doc.width = Math.round(doc.width);
  doc.height = Math.round(doc.height);
  return doc;
}

export function shotQueueFromJSON(raw: unknown): ShotQueue {
  const q = emptyShotQueue();
  if (!raw || typeof raw !== 'object') return q;
  const r = raw as Partial<ShotQueue>;
  q.failures = typeof r.failures === 'number' && r.failures >= 0 ? r.failures : 0;
  q.retryAt = typeof r.retryAt === 'number' && r.retryAt >= 0 ? r.retryAt : 0;
  for (const item of Array.isArray(r.items) ? r.items : []) {
    if (!item || typeof item !== 'object') continue;
    const i = item as PendingShot;
    if (typeof i.id !== 'string' || !isMeta(i.meta)) continue;
    q.items.push({
      id: i.id,
      meta: i.meta,
      uploaded: i.uploaded === true,
      attempts: typeof i.attempts === 'number' ? i.attempts : 0,
    });
  }
  return q;
}

// ---------- base64 (chrome.storage only holds JSON) ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- capture target ----------

export interface CaptureTarget {
  windowId: number;
}

export interface Capturer {
  /** Focused normal Chrome window with an http(s) active tab, or null. */
  target(): Promise<CaptureTarget | null>;
  /** JPEG data URL of the visible tab. */
  capture(windowId: number): Promise<string>;
}

export function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** Chrome implementation of {@link Capturer}. */
export function chromeCapturer(): Capturer {
  return {
    async target() {
      try {
        if ((await chrome.idle.queryState(IDLE_DETECTION_SECONDS)) === 'locked') return null;
        const win = await chrome.windows.getLastFocused({ populate: true });
        if (!win.focused || win.incognito || win.id === undefined) return null;
        const tab = win.tabs?.find((t) => t.active);
        if (!tab || !isCapturableUrl(tab.url)) return null;
        return { windowId: win.id };
      } catch {
        return null;
      }
    },
    capture: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 }),
  };
}

// ---------- manager ----------

export type CaptureOutcome =
  | 'no-session'
  | 'not-due'
  | 'disabled'
  | 'no-target'
  | 'failed'
  | 'duplicate'
  | 'captured';

/** Permission-denied uploads (user disabled, file of another uid…) are retried this many times. */
export const MAX_SHOT_DENIED_ATTEMPTS = 3;
const RETRY = new Set(['unavailable', 'deadline-exceeded', 'unauthenticated', 'resource-exhausted', 'aborted']);

export interface ScreenshotDeps {
  store: StateStore;
  remote: Remote;
  capturer: Capturer;
  processor: ImageProcessor;
  now?: () => number;
  random?: () => number;
}

export class ScreenshotManager {
  private readonly store: StateStore;
  private readonly remote: Remote;
  private readonly capturer: Capturer;
  private readonly processor: ImageProcessor;
  private readonly now: () => number;
  private readonly random: () => number;
  private draining: Promise<void> | null = null;
  private drainAgain = false;

  constructor(deps: ScreenshotDeps) {
    this.store = deps.store;
    this.remote = deps.remote;
    this.capturer = deps.capturer;
    this.processor = deps.processor;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  /**
   * Called on every pulse. `force` (dev debug only) makes the current instant
   * the planned one.
   */
  async maybeCapture(force = false): Promise<CaptureOutcome> {
    const at = this.now();
    const job = await this.store.run(async () => {
      const session = this.store.session;
      if (!session) return 'no-session' as const;
      const prev = this.store.shotPlan;
      const slotStart = slotStartOf(at);
      if (force && prev?.slotStart === slotStart && prev.taken) return 'duplicate' as const;
      const plan = force ? { slotStart, at, done: false } : planFor(prev, at, this.random);
      if (plan !== prev) {
        this.store.shotPlan = plan;
        await this.store.save('shotPlan');
      }
      if (!isDue(plan, at)) return 'not-due' as const;
      // One attempt per block, whatever happens next.
      plan.done = true;
      await this.store.save('shotPlan');
      const org = this.store.meta.org;
      if (!org || org.uid !== session.uid || !org.screenshotsEnabled) return 'disabled' as const;
      return { session, slotStart: plan.slotStart, blur: org.blurScreenshots };
    });
    if (typeof job === 'string') return job;

    const target = await this.capturer.target();
    if (!target) return 'no-target';
    let processed;
    const takenAt = this.now();
    try {
      const dataUrl = await this.capturer.capture(target.windowId);
      processed = await this.processor.process(dataUrl, { blur: job.blur });
    } catch (err) {
      // chrome:// or Web Store page raced in, tab closed, decode failure…
      console.warn('[timetracking] no se pudo tomar la captura', err);
      return 'failed';
    }
    // Never keep a sharp image when blurring is required.
    if (job.blur && !processed.blurred) {
      console.warn('[timetracking] captura descartada: no se pudo difuminar');
      return 'failed';
    }

    const uid = job.session.uid;
    const id = screenshotId(uid, job.slotStart);
    const shot: PendingShot = {
      id,
      meta: {
        uid,
        sessionId: job.session.id,
        takenAt,
        storagePath: screenshotStoragePath(uid, takenAt, id),
        blurred: processed.blurred,
        width: processed.width,
        height: processed.height,
      },
      uploaded: false,
      attempts: 0,
    };
    const data = bytesToBase64(processed.bytes);
    return this.store.run(async () => {
      // The work day may have been closed (or another one started) while capturing.
      if (this.store.session?.id !== job.session.id) return 'no-session' as const;
      const plan = this.store.shotPlan;
      const q = this.store.shots;
      if (q.items.some((i) => i.id === id)) return 'duplicate' as const;
      // Data first: the index never points to a missing image.
      await this.store.putShotData(id, data);
      const { added, dropped } = enqueueShot(q, shot);
      await this.store.save('shots');
      await this.store.removeShotData(dropped);
      if (plan && plan.slotStart === job.slotStart) {
        plan.taken = true;
        await this.store.save('shotPlan');
      }
      return added ? ('captured' as const) : ('duplicate' as const);
    });
  }

  /** Uploads pending screenshots (one at a time). Concurrent calls share one drain. */
  drain(force = false): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        let f = force;
        do {
          this.drainAgain = false;
          await this.drainOnce(f);
          f = false;
        } while (this.drainAgain);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private async drainOnce(force: boolean): Promise<void> {
    for (;;) {
      const head = await this.store.run(() => {
        const q = this.store.shots;
        if (!force && q.retryAt > this.now()) return null;
        const i = q.items[0];
        return i ? { ...i } : null;
      });
      if (!head) return;
      force = false;

      let outcome: 'ok' | 'retry' | 'drop' = 'ok';
      let uploadedNow = head.uploaded;
      try {
        const uid = await this.remote.currentUid();
        if (uid === null) throw Object.assign(new Error('Sin sesión'), { code: 'unauthenticated' });
        if (uid !== head.meta.uid) throw Object.assign(new Error('captura de otro usuario'), { code: 'wrong-user' });
        if (!head.uploaded) {
          await this.uploadOnce(head);
          uploadedNow = true;
        }
        await this.remote.putScreenshotMeta(head.id, toScreenshotDoc(head.meta));
      } catch (err) {
        const code = errorCode(err);
        if (code === 'permission-denied') {
          outcome = head.attempts + 1 >= MAX_SHOT_DENIED_ATTEMPTS ? 'drop' : 'retry';
        } else if (RETRY.has(code)) {
          outcome = 'retry';
        } else {
          outcome = 'drop';
        }
        if (outcome === 'drop') console.warn(`[timetracking] captura ${head.id} descartada (${code})`, err);
      }

      await this.store.run(async () => {
        const q = this.store.shots;
        const idx = q.items.findIndex((i) => i.id === head.id);
        const item = idx >= 0 ? q.items[idx] : undefined;
        if (outcome === 'ok' || outcome === 'drop') {
          if (idx >= 0) q.items.splice(idx, 1);
          q.failures = 0;
          q.retryAt = 0;
          await this.store.save('shots');
          await this.store.removeShotData([head.id]);
          return;
        }
        if (item) {
          item.attempts += 1;
          if (uploadedNow) item.uploaded = true;
        }
        q.failures += 1;
        q.retryAt = this.now() + backoffMs(q.failures);
        await this.store.save('shots');
      });
      if (outcome === 'retry') return;
    }
  }

  /** Upload; "already exists" (Storage never overwrites) counts as uploaded. */
  private async uploadOnce(shot: PendingShot): Promise<void> {
    const data = await this.store.run(() => this.store.getShotData(shot.id));
    if (data === null) throw Object.assign(new Error('imagen de la captura no encontrada'), { code: 'missing-data' });
    try {
      await this.remote.uploadScreenshot(shot.meta.storagePath, base64ToBytes(data));
    } catch (err) {
      const code = errorCode(err);
      if (code !== 'permission-denied' && code !== 'already-exists') throw err;
      if (!(await this.remote.screenshotExists(shot.meta.storagePath))) throw err;
    }
  }
}
