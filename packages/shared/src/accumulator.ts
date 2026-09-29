/**
 * SlotAccumulator — pure, deterministic activity accumulator (spec 3.1-3.2).
 *
 * It never touches `chrome.*` nor reads the clock: every input carries its own
 * timestamp (epoch ms). The extension feeds it events and persists it with
 * `toJSON()` / `SlotAccumulator.fromJSON()` in `chrome.storage.local`.
 *
 * Measurement model
 * -----------------
 * Time is measured in whole seconds. Second `s` is the interval
 * [s*1000, s*1000+1000). Every event at time `t` first *advances* the clock
 * from the previous event time `lastEventAt` to `t`, attributing every second
 * whose start lies in [lastEventAt, t) to the state (session, focus, idle)
 * that was valid during that interval; then it applies its own change.
 * Because intervals are consecutive and half-open, each second is attributed
 * at most once, so all counters are consistent with each other.
 *
 * - trackedSeconds: seconds of the block attributed while the work day
 *   (session) was open. Decision on gaps: if two consecutive events are more
 *   than `maxGapMs` (default 90 s) apart, the interval between them is NOT
 *   counted. The extension pulses at least every 30 s (chrome.alarms), so a
 *   longer gap means the browser was closed, the computer slept or the
 *   service worker could not run: we record "no data" rather than inventing
 *   time (spec 3.6). Thus trackedSeconds covers the span between the first
 *   and last measured instants inside the block, minus those gaps.
 * - activeSeconds: a tracked second is active if the content script marked it
 *   (`markActiveSecond`), OR if the focus is null (outside Chrome) / not
 *   measurable (page without content script) and the idle state is 'active'.
 *   Active seconds are kept as a set, so a second is counted once even when
 *   both sources report it. Only tracked seconds can be active, therefore
 *   activeSeconds <= trackedSeconds <= 600 always holds.
 * - outsideChromeSeconds: tracked seconds with focus === null.
 * - domains / urls: tracked seconds with a focused http/https URL, keyed by
 *   domain and by sanitized URL (no query/hash). Top 20 URLs per block.
 *
 * Out-of-order events (timestamp older than the last event) never move the
 * clock backwards: state changes then apply from `lastEventAt` onwards, and
 * activity marks are still recorded for their own second (if the block has
 * not been emitted as closed yet).
 */

import { MAX_TICK_GAP_MS, MAX_URLS_PER_SLOT } from './config.js';
import { SLOT_MS, SLOT_SECONDS, slotStartOf } from './slots.js';
import { domainOf, sanitizeUrl } from './url.js';
import type { ActivitySlot, IdleState, UrlTime } from './types.js';

/** Focus reported by the extension. `null` = no Chrome window focused. */
export interface FocusInput {
  url: string;
  /** false for pages without content script (chrome://, Web Store, PDF...). */
  measurable: boolean;
}

export interface FlushResult {
  /** Blocks that ended before `ms`. Returned once, then forgotten. */
  closed: ActivitySlot[];
  /** Block containing `ms` (partial), or null if it has no tracked seconds. */
  current: ActivitySlot | null;
}

export interface SlotAccumulatorOptions {
  uid: string;
  maxGapMs?: number;
  maxUrls?: number;
}

interface FocusState {
  url: string | null;
  domain: string | null;
  measurable: boolean;
}

interface SlotState {
  slotStart: number;
  sessionId: string;
  tracked: Set<number>;
  active: Set<number>;
  outside: number;
  domains: Map<string, number>;
  urls: Map<string, number>;
}

export interface SlotStateJSON {
  slotStart: number;
  sessionId: string;
  /** Tracked second offsets within the block (0..599), ascending. */
  tracked: number[];
  /** Active (marked) second offsets within the block (0..599), ascending. */
  active: number[];
  outside: number;
  domains: Record<string, number>;
  urls: Record<string, number>;
}

export interface SlotAccumulatorJSON {
  v: 1;
  uid: string;
  maxGapMs: number;
  maxUrls: number;
  sessionId: string | null;
  lastEventAt: number | null;
  idle: IdleState;
  focus: FocusState | null;
  closedUntil: number;
  slots: SlotStateJSON[];
}

const IDLE_STATES: readonly IdleState[] = ['active', 'idle', 'locked'];

function assertTime(ms: number, what: string): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(`SlotAccumulator.${what}: invalid timestamp ${String(ms)}`);
  }
}

function toFocusState(focus: FocusInput | null): FocusState | null {
  if (focus === null) return null;
  const url = sanitizeUrl(focus.url);
  const domain = url === null ? null : domainOf(focus.url);
  // Non http/https pages never get a content script, so they cannot be
  // measured by it regardless of what the caller says.
  return { url, domain, measurable: focus.measurable === true && url !== null };
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key) ?? 0;
  return out;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export class SlotAccumulator {
  readonly uid: string;
  readonly maxGapMs: number;
  readonly maxUrls: number;

  private _sessionId: string | null = null;
  private _lastEventAt: number | null = null;
  private idle: IdleState = 'active';
  private focus: FocusState | null = null;
  /** Blocks starting before this instant were already emitted as closed. */
  private closedUntil = 0;
  private readonly slots = new Map<number, SlotState>();

  constructor(options: SlotAccumulatorOptions) {
    if (!options.uid) throw new Error('SlotAccumulator: uid is required');
    this.uid = options.uid;
    this.maxGapMs = options.maxGapMs ?? MAX_TICK_GAP_MS;
    this.maxUrls = options.maxUrls ?? MAX_URLS_PER_SLOT;
  }

  /** Open session id, or null when the work day is closed. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Timestamp of the latest event processed (the accumulator's clock). */
  get lastEventAt(): number | null {
    return this._lastEventAt;
  }

  get idleState(): IdleState {
    return this.idle;
  }

  /** Opens (sessionId) or closes (null) the work day at `ms`. */
  setSession(sessionId: string | null, ms: number): void {
    assertTime(ms, 'setSession');
    this.advance(ms);
    this._sessionId = sessionId === '' ? null : sessionId;
  }

  /** chrome.idle state change. */
  setIdleState(state: IdleState, ms: number): void {
    assertTime(ms, 'setIdleState');
    if (!IDLE_STATES.includes(state)) throw new TypeError(`SlotAccumulator: invalid idle state ${String(state)}`);
    this.advance(ms);
    this.idle = state;
  }

  /** Active tab of the focused window changed; `null` = outside Chrome. */
  setFocus(focus: FocusInput | null, ms: number): void {
    assertTime(ms, 'setFocus');
    this.advance(ms);
    this.focus = toFocusState(focus);
  }

  /** The content script saw keyboard/mouse input during the second of `ms`. */
  markActiveSecond(ms: number): void {
    assertTime(ms, 'markActiveSecond');
    this.advance(ms);
    if (this._sessionId === null) return;
    const second = Math.floor(ms / 1000);
    const slot = this.slotFor(second);
    if (slot) slot.active.add(second - slot.slotStart / 1000);
  }

  /** Heartbeat: just advances the clock with the current state. */
  tick(ms: number): void {
    assertTime(ms, 'tick');
    this.advance(ms);
  }

  /**
   * Advances to `ms` and returns the finished blocks (removed from memory) and
   * a snapshot of the block in progress (kept). Blocks without tracked seconds
   * are dropped. Re-emitting the current block is safe: its Firestore id is
   * deterministic and the upsert idempotent.
   */
  flush(ms: number): FlushResult {
    assertTime(ms, 'flush');
    this.advance(ms);
    const now = Math.max(ms, this._lastEventAt ?? ms);
    const currentStart = slotStartOf(now);
    const closed: ActivitySlot[] = [];
    for (const start of [...this.slots.keys()].sort((a, b) => a - b)) {
      if (start >= currentStart) continue;
      const slot = this.slots.get(start);
      this.slots.delete(start);
      if (slot && slot.tracked.size > 0) closed.push(this.build(slot));
    }
    this.closedUntil = Math.max(this.closedUntil, currentStart);
    const cur = this.slots.get(currentStart);
    return { closed, current: cur && cur.tracked.size > 0 ? this.build(cur) : null };
  }

  toJSON(): SlotAccumulatorJSON {
    const slots = [...this.slots.values()]
      .sort((a, b) => a.slotStart - b.slotStart)
      .map<SlotStateJSON>((s) => ({
        slotStart: s.slotStart,
        sessionId: s.sessionId,
        tracked: [...s.tracked].sort((a, b) => a - b),
        active: [...s.active].sort((a, b) => a - b),
        outside: s.outside,
        domains: sortedRecord(s.domains),
        urls: sortedRecord(s.urls),
      }));
    return {
      v: 1,
      uid: this.uid,
      maxGapMs: this.maxGapMs,
      maxUrls: this.maxUrls,
      sessionId: this._sessionId,
      lastEventAt: this._lastEventAt,
      idle: this.idle,
      focus: this.focus ? { ...this.focus } : null,
      closedUntil: this.closedUntil,
      slots,
    };
  }

  static fromJSON(json: unknown): SlotAccumulator {
    const j = json as Partial<SlotAccumulatorJSON> | null;
    if (!j || typeof j !== 'object' || j.v !== 1) throw new Error('SlotAccumulator.fromJSON: unsupported data');
    if (typeof j.uid !== 'string' || !j.uid) throw new Error('SlotAccumulator.fromJSON: missing uid');
    const acc = new SlotAccumulator({
      uid: j.uid,
      ...(typeof j.maxGapMs === 'number' ? { maxGapMs: j.maxGapMs } : {}),
      ...(typeof j.maxUrls === 'number' ? { maxUrls: j.maxUrls } : {}),
    });
    acc._sessionId = typeof j.sessionId === 'string' && j.sessionId ? j.sessionId : null;
    acc._lastEventAt = typeof j.lastEventAt === 'number' && Number.isFinite(j.lastEventAt) ? j.lastEventAt : null;
    acc.idle = j.idle && IDLE_STATES.includes(j.idle) ? j.idle : 'active';
    const f = j.focus;
    acc.focus =
      f && typeof f === 'object'
        ? {
            url: typeof f.url === 'string' ? f.url : null,
            domain: typeof f.domain === 'string' ? f.domain : null,
            measurable: f.measurable === true && typeof f.url === 'string',
          }
        : null;
    acc.closedUntil = typeof j.closedUntil === 'number' && Number.isFinite(j.closedUntil) ? j.closedUntil : 0;
    const validOffset = (n: unknown): n is number =>
      typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < SLOT_SECONDS;
    const toMap = (rec: unknown): Map<string, number> => {
      const m = new Map<string, number>();
      if (rec && typeof rec === 'object') {
        for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) m.set(k, v);
        }
      }
      return m;
    };
    for (const s of Array.isArray(j.slots) ? j.slots : []) {
      if (!s || typeof s.slotStart !== 'number' || s.slotStart % SLOT_MS !== 0) continue;
      const tracked = new Set((Array.isArray(s.tracked) ? s.tracked : []).filter(validOffset));
      acc.slots.set(s.slotStart, {
        slotStart: s.slotStart,
        sessionId: typeof s.sessionId === 'string' ? s.sessionId : '',
        tracked,
        active: new Set((Array.isArray(s.active) ? s.active : []).filter(validOffset)),
        outside: Math.min(typeof s.outside === 'number' && s.outside > 0 ? s.outside : 0, tracked.size),
        domains: toMap(s.domains),
        urls: toMap(s.urls),
      });
    }
    return acc;
  }

  // ---------------------------------------------------------------------------

  /** Returns (creating if needed) the state of the block containing `second`. */
  private slotFor(second: number): SlotState | null {
    const slotStart = slotStartOf(second * 1000);
    if (slotStart < this.closedUntil) return null; // already emitted as closed
    let slot = this.slots.get(slotStart);
    if (!slot) {
      slot = {
        slotStart,
        sessionId: this._sessionId ?? '',
        tracked: new Set(),
        active: new Set(),
        outside: 0,
        domains: new Map(),
        urls: new Map(),
      };
      this.slots.set(slotStart, slot);
    }
    return slot;
  }

  /** Attributes the interval [lastEventAt, ms) to the current state. */
  private advance(ms: number): void {
    const last = this._lastEventAt;
    if (last === null) {
      this._lastEventAt = ms;
      return;
    }
    if (ms <= last) return; // never move backwards
    this._lastEventAt = ms;
    const sessionId = this._sessionId;
    if (sessionId === null) return; // work day closed: nothing is tracked
    if (ms - last > this.maxGapMs) return; // gap without pulses: "no data"

    const focus = this.focus;
    const idleDerivedActive = (focus === null || !focus.measurable) && this.idle === 'active';
    const firstSecond = Math.ceil(last / 1000);
    const endSecond = Math.ceil(ms / 1000); // exclusive
    for (let second = firstSecond; second < endSecond; second++) {
      const slot = this.slotFor(second);
      if (!slot) continue;
      const offset = second - slot.slotStart / 1000;
      if (slot.tracked.has(offset)) continue;
      slot.tracked.add(offset);
      slot.sessionId = sessionId;
      if (idleDerivedActive) slot.active.add(offset);
      if (focus === null) {
        slot.outside++;
      } else if (focus.url !== null) {
        if (focus.domain !== null) inc(slot.domains, focus.domain);
        inc(slot.urls, focus.url);
      }
    }
  }

  private build(slot: SlotState): ActivitySlot {
    let activeSeconds = 0;
    for (const offset of slot.active) if (slot.tracked.has(offset)) activeSeconds++;
    const trackedSeconds = Math.min(slot.tracked.size, SLOT_SECONDS);
    const urls: UrlTime[] = [...slot.urls.entries()]
      .map(([url, seconds]) => ({ url, seconds }))
      .sort((a, b) => b.seconds - a.seconds || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
      .slice(0, this.maxUrls);
    return {
      uid: this.uid,
      sessionId: slot.sessionId,
      slotStart: slot.slotStart,
      trackedSeconds,
      activeSeconds: Math.min(activeSeconds, trackedSeconds),
      outsideChromeSeconds: Math.min(slot.outside, trackedSeconds),
      domains: sortedRecord(slot.domains),
      urls,
    };
  }
}
