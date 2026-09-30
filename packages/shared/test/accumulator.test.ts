import { describe, expect, it } from 'vitest';
import { SlotAccumulator, type FocusInput } from '../src/accumulator.js';
import { SLOT_MS } from '../src/slots.js';
import type { ActivitySlot } from '../src/types.js';

/** 2026-09-29 12:00:00 UTC — aligned to a 10-minute block. */
const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);
const S = 1000;
const UID = 'user1';
const WEB: FocusInput = { url: 'https://docs.google.com/document/d/abc?tab=1#heading', measurable: true };
const CHROME_PAGE: FocusInput = { url: 'chrome://extensions', measurable: false };

function newAcc(): SlotAccumulator {
  return new SlotAccumulator({ uid: UID });
}

/** Ticks every `step` ms from `from` (exclusive) up to `to` (inclusive). */
function tickRange(acc: SlotAccumulator, from: number, to: number, step = 30 * S): void {
  for (let t = from + step; t < to; t += step) acc.tick(t);
  acc.tick(to);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function checkInvariants(slot: ActivitySlot): void {
  expect(slot.trackedSeconds).toBeGreaterThanOrEqual(0);
  expect(slot.trackedSeconds).toBeLessThanOrEqual(600);
  expect(slot.activeSeconds).toBeGreaterThanOrEqual(0);
  expect(slot.activeSeconds).toBeLessThanOrEqual(slot.trackedSeconds);
  expect(slot.outsideChromeSeconds).toBeLessThanOrEqual(slot.trackedSeconds);
  expect(slot.meetingSeconds).toBeGreaterThanOrEqual(0);
  expect(slot.activeSeconds + (slot.meetingSeconds ?? 0)).toBeLessThanOrEqual(slot.trackedSeconds);
  expect(sum(Object.values(slot.domains)) + slot.outsideChromeSeconds).toBeLessThanOrEqual(slot.trackedSeconds);
  expect(sum(slot.urls.map((u) => u.seconds))).toBeLessThanOrEqual(slot.trackedSeconds);
  expect(slot.urls.length).toBeLessThanOrEqual(20);
  expect(slot.slotStart % SLOT_MS).toBe(0);
}

describe('SlotAccumulator — basics', () => {
  it('requires a uid', () => {
    expect(() => new SlotAccumulator({ uid: '' })).toThrow();
  });

  it('returns nothing before any data', () => {
    const acc = newAcc();
    expect(acc.flush(T0)).toEqual({ closed: [], current: null });
  });

  it('does not track while the work day is closed', () => {
    const acc = newAcc();
    acc.setFocus(WEB, T0);
    tickRange(acc, T0, T0 + 300 * S);
    acc.markActiveSecond(T0 + 200 * S);
    expect(acc.flush(T0 + 300 * S)).toEqual({ closed: [], current: null });
  });

  it('tracks time on a web page with domain and sanitized URL', () => {
    const acc = newAcc();
    acc.setSession('sess1', T0);
    acc.setFocus(WEB, T0);
    tickRange(acc, T0, T0 + 300 * S);
    const { closed, current } = acc.flush(T0 + 300 * S);
    expect(closed).toEqual([]);
    expect(current).toEqual<ActivitySlot>({
      uid: UID,
      sessionId: 'sess1',
      slotStart: T0,
      trackedSeconds: 300,
      activeSeconds: 0,
      outsideChromeSeconds: 0,
      meetingSeconds: 0,
      domains: { 'docs.google.com': 300 },
      urls: [{ url: 'https://docs.google.com/document/d/abc', seconds: 300 }],
    });
  });

  it('counts content-script marks once per second (duplicates ignored)', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.markActiveSecond(T0 + 10 * S);
    acc.markActiveSecond(T0 + 10 * S + 400);
    acc.markActiveSecond(T0 + 10 * S + 999);
    acc.markActiveSecond(T0 + 11 * S);
    acc.markActiveSecond(T0 + 25 * S);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current?.trackedSeconds).toBe(60);
    expect(current?.activeSeconds).toBe(3);
  });

  it('measurable page + idle active without marks is NOT active', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.setIdleState('active', T0);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current?.activeSeconds).toBe(0);
  });
});

describe('SlotAccumulator — outside Chrome and non-measurable pages', () => {
  it('outside Chrome with idle=active counts as active and outside', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current).toMatchObject({ trackedSeconds: 60, activeSeconds: 60, outsideChromeSeconds: 60, domains: {}, urls: [] });
  });

  it('outside Chrome with idle=idle or locked is tracked but inactive', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    acc.setIdleState('active', T0);
    acc.tick(T0 + 20 * S);
    acc.setIdleState('idle', T0 + 20 * S);
    acc.tick(T0 + 50 * S);
    acc.setIdleState('locked', T0 + 50 * S);
    const { current } = acc.flush(T0 + 80 * S);
    expect(current).toMatchObject({ trackedSeconds: 80, activeSeconds: 20, outsideChromeSeconds: 80 });
  });

  it('chrome:// pages are inside Chrome, not measurable, without domain', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(CHROME_PAGE, T0);
    acc.tick(T0 + 30 * S);
    acc.setIdleState('idle', T0 + 30 * S);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current).toMatchObject({ trackedSeconds: 60, activeSeconds: 30, outsideChromeSeconds: 0, domains: {}, urls: [] });
  });

  it('a non-http URL is treated as not measurable even if the caller says measurable', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus({ url: 'chrome://newtab/', measurable: true }, T0);
    const { current } = acc.flush(T0 + 10 * S);
    expect(current?.activeSeconds).toBe(10);
  });

  it('http page without content script (PDF) counts domain and idle-derived activity', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus({ url: 'https://www.example.com/file.pdf?token=secret', measurable: false }, T0);
    const { current } = acc.flush(T0 + 40 * S);
    expect(current).toMatchObject({
      trackedSeconds: 40,
      activeSeconds: 40,
      domains: { 'example.com': 40 },
      urls: [{ url: 'https://www.example.com/file.pdf', seconds: 40 }],
    });
  });

  it('a second marked by both sources counts once', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(CHROME_PAGE, T0);
    for (let i = 0; i < 10; i++) acc.markActiveSecond(T0 + i * S + 100);
    const { current } = acc.flush(T0 + 10 * S);
    expect(current?.trackedSeconds).toBe(10);
    expect(current?.activeSeconds).toBe(10);
  });

  it('switching focus attributes time to each state', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus({ url: 'https://a.com/x', measurable: true }, T0);
    acc.setFocus({ url: 'https://b.com/y', measurable: true }, T0 + 15 * S);
    acc.setFocus(null, T0 + 45 * S);
    acc.setFocus({ url: 'https://a.com/x#other', measurable: true }, T0 + 50 * S);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current).toMatchObject({
      trackedSeconds: 60,
      outsideChromeSeconds: 5,
      activeSeconds: 5,
      domains: { 'a.com': 25, 'b.com': 30 },
      urls: [
        { url: 'https://b.com/y', seconds: 30 },
        { url: 'https://a.com/x', seconds: 25 },
      ],
    });
  });
});

describe('SlotAccumulator — block boundaries', () => {
  it('splits time across a block boundary and emits the closed block once', () => {
    const acc = newAcc();
    acc.setSession('s', T0 + 590 * S);
    acc.setFocus(WEB, T0 + 590 * S);
    acc.tick(T0 + 620 * S);
    const r1 = acc.flush(T0 + 620 * S);
    expect(r1.closed).toHaveLength(1);
    expect(r1.closed[0]).toMatchObject({ slotStart: T0, trackedSeconds: 10 });
    expect(r1.current).toMatchObject({ slotStart: T0 + SLOT_MS, trackedSeconds: 20 });
    const r2 = acc.flush(T0 + 630 * S);
    expect(r2.closed).toEqual([]);
    expect(r2.current).toMatchObject({ slotStart: T0 + SLOT_MS, trackedSeconds: 30 });
  });

  it('emits several closed blocks in order when flush happens late', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    tickRange(acc, T0, T0 + 25 * 60 * S);
    const { closed, current } = acc.flush(T0 + 25 * 60 * S);
    expect(closed.map((c) => c.slotStart)).toEqual([T0, T0 + SLOT_MS]);
    expect(closed.map((c) => c.trackedSeconds)).toEqual([600, 600]);
    expect(current).toMatchObject({ slotStart: T0 + 2 * SLOT_MS, trackedSeconds: 300 });
  });

  it('never exceeds 600 tracked seconds in a full block', () => {
    const acc = newAcc();
    acc.setSession('s', T0 - 5 * S);
    acc.setFocus(null, T0 - 5 * S);
    for (let t = T0 - 5 * S; t <= T0 + SLOT_MS + 5 * S; t += 700) acc.tick(t);
    const { closed } = acc.flush(T0 + SLOT_MS + 5 * S);
    const full = closed.find((c) => c.slotStart === T0);
    expect(full?.trackedSeconds).toBe(600);
    expect(full?.activeSeconds).toBe(600);
    closed.forEach(checkInvariants);
  });

  it('partitions fractional timestamps exactly (no double counting)', () => {
    const acc = newAcc();
    acc.setSession('s', T0 + 123);
    acc.setFocus(null, T0 + 123);
    for (let t = T0 + 777; t < T0 + 650_250; t += 29_777) acc.tick(t);
    const { closed, current } = acc.flush(T0 + 650_250);
    // Second starts in [T0+123, T0+650250): seconds 1..650 => 650 seconds.
    const total = sum(closed.map((c) => c.trackedSeconds)) + (current?.trackedSeconds ?? 0);
    expect(total).toBe(650);
    expect(closed[0]?.trackedSeconds).toBe(599);
    expect(current?.trackedSeconds).toBe(51);
  });

  it('ignores late activity marks for a block already emitted as closed', () => {
    const acc = newAcc();
    acc.setSession('s', T0 + 580 * S);
    acc.setFocus(WEB, T0 + 580 * S);
    acc.flush(T0 + 610 * S);
    acc.markActiveSecond(T0 + 590 * S); // out of order, block closed
    const { closed, current } = acc.flush(T0 + 620 * S);
    expect(closed).toEqual([]);
    expect(current).toMatchObject({ trackedSeconds: 20, activeSeconds: 0 });
  });
});

describe('SlotAccumulator — gaps and sessions', () => {
  it('does not count intervals longer than 90 s without events', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    acc.tick(T0 + 30 * S); // +30 counted
    acc.tick(T0 + 121 * S); // gap of 91 s -> not counted
    acc.tick(T0 + 150 * S); // +29 counted
    const { current } = acc.flush(T0 + 150 * S);
    expect(current?.trackedSeconds).toBe(59);
    expect(current?.activeSeconds).toBe(59);
  });

  it('counts an interval of exactly 90 s', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    acc.tick(T0 + 90 * S);
    expect(acc.flush(T0 + 90 * S).current?.trackedSeconds).toBe(90);
  });

  it('a gap spanning whole blocks leaves them without data', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    acc.tick(T0 + 60 * S);
    acc.tick(T0 + 40 * 60 * S); // browser closed ~39 min
    acc.tick(T0 + 40 * 60 * S + 30 * S);
    const { closed, current } = acc.flush(T0 + 40 * 60 * S + 30 * S);
    expect(closed.map((c) => [c.slotStart, c.trackedSeconds])).toEqual([[T0, 60]]);
    expect(current).toMatchObject({ slotStart: T0 + 4 * SLOT_MS, trackedSeconds: 30 });
  });

  it('a mark inside a gap does not create activity beyond tracked time', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.markActiveSecond(T0 + 200 * S); // after a 200 s gap
    const { current } = acc.flush(T0 + 200 * S);
    expect(current).toBeNull();
    const r = acc.flush(T0 + 201 * S);
    expect(r.current).toMatchObject({ trackedSeconds: 1, activeSeconds: 1 });
  });

  it('stops tracking when the session closes and merges a reopened session in the same block', () => {
    const acc = newAcc();
    acc.setSession('s1', T0);
    acc.setFocus(null, T0);
    acc.setSession(null, T0 + 60 * S);
    acc.tick(T0 + 90 * S);
    const mid = acc.flush(T0 + 120 * S);
    expect(mid.current).toMatchObject({ sessionId: 's1', trackedSeconds: 60 });
    acc.setSession('s2', T0 + 120 * S);
    const { current } = acc.flush(T0 + 180 * S);
    expect(current).toMatchObject({ sessionId: 's2', trackedSeconds: 120, activeSeconds: 120 });
    expect(acc.sessionId).toBe('s2');
  });

  it('ignores activity marks while the session is closed', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.setSession(null, T0 + 10 * S);
    acc.markActiveSecond(T0 + 20 * S);
    expect(acc.flush(T0 + 30 * S).current).toMatchObject({ trackedSeconds: 10, activeSeconds: 0 });
  });

  it('out-of-order events never move the clock backwards', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.tick(T0 + 60 * S);
    acc.tick(T0 + 30 * S); // older: ignored
    acc.markActiveSecond(T0 + 45 * S); // older mark: still recorded
    expect(acc.lastEventAt).toBe(T0 + 60 * S);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current).toMatchObject({ trackedSeconds: 60, activeSeconds: 1 });
  });

  it('a mark on a second not yet attributed counts once the clock passes it', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.tick(T0 + 10 * S);
    acc.markActiveSecond(T0 + 10 * S); // second 10 starts exactly now: not tracked yet
    expect(acc.flush(T0 + 10 * S).current).toMatchObject({ trackedSeconds: 10, activeSeconds: 0 });
    acc.tick(T0 + 11 * S);
    expect(acc.flush(T0 + 11 * S).current).toMatchObject({ trackedSeconds: 11, activeSeconds: 1 });
  });

  it('a pending mark survives toJSON/fromJSON', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.markActiveSecond(T0 + 5 * S);
    const restored = SlotAccumulator.fromJSON(JSON.parse(JSON.stringify(acc.toJSON())));
    restored.tick(T0 + 6 * S);
    expect(restored.flush(T0 + 6 * S).current).toMatchObject({ trackedSeconds: 6, activeSeconds: 1 });
  });

  it('a block left partial by closing the session is emitted as closed on a later flush', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    tickRange(acc, T0, T0 + 90 * S);
    acc.setSession(null, T0 + 120 * S);
    const atClose = acc.flush(T0 + 120 * S);
    expect(atClose.closed).toEqual([]);
    expect(atClose.current).toMatchObject({ slotStart: T0, trackedSeconds: 120, outsideChromeSeconds: 120 });
    const later = acc.flush(T0 + 3 * SLOT_MS);
    expect(later.closed).toHaveLength(1);
    expect(later.closed[0]).toMatchObject({ slotStart: T0, trackedSeconds: 120 });
    expect(later.current).toBeNull();
    expect(acc.flush(T0 + 4 * SLOT_MS).closed).toEqual([]);
  });

  it('a gap longer than 90 s after a state change keeps that state for later intervals', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(null, T0);
    acc.setIdleState('locked', T0 + 10 * S);
    acc.tick(T0 + 200 * S); // 190 s gap: no data
    acc.tick(T0 + 230 * S); // 30 s counted, still locked
    const { current } = acc.flush(T0 + 230 * S);
    expect(current).toMatchObject({ trackedSeconds: 40, activeSeconds: 10, outsideChromeSeconds: 40 });
  });

  it('rejects invalid timestamps and idle states', () => {
    const acc = newAcc();
    expect(() => acc.tick(Number.NaN)).toThrow(TypeError);
    expect(() => acc.setIdleState('sleepy' as never, T0)).toThrow(TypeError);
  });
});

describe('SlotAccumulator — URLs', () => {
  it('keeps only the top 20 URLs sorted by seconds desc, then url', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    let t = T0;
    for (let i = 1; i <= 25; i++) {
      acc.setFocus({ url: `https://site${String(i).padStart(2, '0')}.com/p?q=${i}`, measurable: true }, t);
      t += (i <= 5 ? 30 : i) * S; // sites 1..5 tie with 30 s each, then site i gets i seconds
    }
    const { current } = acc.flush(t);
    expect(current?.trackedSeconds).toBe(460);
    expect(current?.urls).toHaveLength(20);
    expect(current?.urls.slice(0, 6).map((u) => u.url)).toEqual([
      'https://site01.com/p',
      'https://site02.com/p',
      'https://site03.com/p',
      'https://site04.com/p',
      'https://site05.com/p',
      'https://site25.com/p',
    ]);
    expect(current?.urls[19]).toEqual({ url: 'https://site11.com/p', seconds: 11 });
    expect(Object.keys(current?.domains ?? {})).toHaveLength(25);
    checkInvariants(current!);
  });

  it('merges URLs that differ only in query or hash', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus({ url: 'https://mail.google.com/mail/u/0/?tab=rm#inbox', measurable: true }, T0);
    acc.setFocus({ url: 'https://mail.google.com/mail/u/0/#inbox/FMfcg', measurable: true }, T0 + 10 * S);
    const { current } = acc.flush(T0 + 30 * S);
    expect(current?.urls).toEqual([{ url: 'https://mail.google.com/mail/u/0/', seconds: 30 }]);
  });
});

describe('SlotAccumulator — serialization and determinism', () => {
  function scenario(acc: SlotAccumulator, split?: (a: SlotAccumulator) => SlotAccumulator): ActivitySlot[] {
    const out: ActivitySlot[] = [];
    acc.setSession('s', T0 + 550 * S);
    acc.setFocus(WEB, T0 + 550 * S);
    acc.markActiveSecond(T0 + 555 * S);
    acc.tick(T0 + 580 * S);
    acc.setFocus(null, T0 + 590 * S);
    acc.setIdleState('idle', T0 + 600 * S);
    let a = split ? split(acc) : acc;
    a.tick(T0 + 620 * S);
    const r1 = a.flush(T0 + 620 * S);
    out.push(...r1.closed);
    a = split ? split(a) : a;
    a.setIdleState('active', T0 + 630 * S);
    a.setFocus(CHROME_PAGE, T0 + 640 * S);
    a.markActiveSecond(T0 + 641 * S);
    const r2 = a.flush(T0 + 700 * S);
    out.push(...r2.closed);
    if (r2.current) out.push(r2.current);
    return out;
  }

  const roundTrip = (a: SlotAccumulator): SlotAccumulator =>
    SlotAccumulator.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));

  it('is deterministic: same events produce identical output', () => {
    expect(scenario(newAcc())).toEqual(scenario(newAcc()));
  });

  it('survives toJSON/fromJSON at any point with identical results', () => {
    const plain = scenario(newAcc());
    const restored = scenario(newAcc(), roundTrip);
    expect(restored).toEqual(plain);
    expect(plain).toHaveLength(2);
    plain.forEach(checkInvariants);
  });

  it('serializes state compactly and restores getters', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setIdleState('locked', T0);
    acc.setFocus(WEB, T0);
    acc.tick(T0 + 5 * S);
    const json = acc.toJSON();
    expect(json).toMatchObject({
      v: 1,
      uid: UID,
      sessionId: 's',
      lastEventAt: T0 + 5 * S,
      idle: 'locked',
      focus: { url: 'https://docs.google.com/document/d/abc', domain: 'docs.google.com', measurable: true },
    });
    expect(json.slots[0]?.tracked).toEqual([0, 1, 2, 3, 4]);
    const back = SlotAccumulator.fromJSON(json);
    expect(back.sessionId).toBe('s');
    expect(back.idleState).toBe('locked');
    expect(back.toJSON()).toEqual(json);
  });

  it('rejects unsupported data', () => {
    expect(() => SlotAccumulator.fromJSON(null)).toThrow();
    expect(() => SlotAccumulator.fromJSON({ v: 2, uid: 'x' })).toThrow();
    expect(() => SlotAccumulator.fromJSON({ v: 1 })).toThrow();
  });

  it('sanitizes corrupted serialized slots', () => {
    const acc = SlotAccumulator.fromJSON({
      v: 1,
      uid: UID,
      sessionId: 's',
      lastEventAt: T0 + 10 * S,
      idle: 'bogus',
      focus: null,
      closedUntil: 0,
      slots: [
        { slotStart: T0, sessionId: 's', tracked: [0, 1, 2, 700, -1, 1.5], active: [0, 1, 999], outside: 99, domains: { 'a.com': 2, bad: -3 }, urls: {} },
        { slotStart: T0 + 123, sessionId: 's', tracked: [0], active: [], outside: 0, domains: {}, urls: {} },
      ],
    });
    expect(acc.idleState).toBe('active');
    const { current } = acc.flush(T0 + 10 * S);
    expect(current).toMatchObject({ trackedSeconds: 3, activeSeconds: 2, outsideChromeSeconds: 3, domains: { 'a.com': 2 } });
  });
});

describe('SlotAccumulator — randomized invariants', () => {
  it('keeps activeSeconds <= trackedSeconds <= 600 for random event streams', () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const focuses: (FocusInput | null)[] = [null, WEB, CHROME_PAGE, { url: 'https://x.org/a?b', measurable: false }];
    const idles = ['active', 'idle', 'locked'] as const;
    for (let run = 0; run < 20; run++) {
      const acc = newAcc();
      const slots: ActivitySlot[] = [];
      let t = T0 + Math.floor(rand() * SLOT_MS);
      acc.setSession(`s${run}`, t);
      for (let i = 0; i < 400; i++) {
        t += Math.floor(rand() * 40_000);
        const r = rand();
        if (r < 0.4) acc.markActiveSecond(t);
        else if (r < 0.55) acc.setFocus(focuses[Math.floor(rand() * focuses.length)] ?? null, t);
        else if (r < 0.65) acc.setIdleState(idles[Math.floor(rand() * idles.length)] ?? 'active', t);
        else if (r < 0.7) acc.setSession(rand() < 0.5 ? null : `s${run}`, t);
        else if (r < 0.8) acc.tick(t);
        else if (r < 0.9) acc.setMeeting(rand() < 0.5, t);
        else slots.push(...acc.flush(t).closed);
      }
      const last = acc.flush(t + SLOT_MS);
      slots.push(...last.closed);
      slots.forEach(checkInvariants);
      const starts = slots.map((s) => s.slotStart);
      expect(new Set(starts).size).toBe(starts.length);
    }
  });
});

describe('SlotAccumulator — web meetings', () => {
  it('seconds without input during a meeting are meeting seconds, not active', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus({ url: 'https://meet.google.com/abc-defg-hij', measurable: true }, T0);
    acc.setMeeting(true, T0);
    tickRange(acc, T0, T0 + 300 * S);
    const { current } = acc.flush(T0 + 300 * S);
    expect(current).toMatchObject({ trackedSeconds: 300, activeSeconds: 0, meetingSeconds: 300 });
    expect(acc.inMeeting).toBe(true);
    checkInvariants(current!);
  });

  it('a second with keyboard/mouse is active, never a meeting second', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0); // writing in Docs, meeting in a background tab
    acc.setMeeting(true, T0);
    for (let i = 0; i < 10; i++) acc.markActiveSecond(T0 + i * S + 500);
    acc.tick(T0 + 60 * S);
    // A late mark (content scripts report up to 10 s late) for a second already attributed.
    acc.markActiveSecond(T0 + 30 * S);
    const { current } = acc.flush(T0 + 60 * S);
    expect(current).toMatchObject({ trackedSeconds: 60, activeSeconds: 11, meetingSeconds: 49 });
    checkInvariants(current!);
  });

  it('idle-derived activity (outside Chrome / not measurable, idle active) wins over the meeting', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setMeeting(true, T0);
    acc.setFocus(null, T0); // in another app, meeting audio in a Chrome tab
    acc.tick(T0 + 20 * S);
    acc.setIdleState('idle', T0 + 20 * S);
    acc.tick(T0 + 50 * S);
    const { current } = acc.flush(T0 + 50 * S);
    expect(current).toMatchObject({ trackedSeconds: 50, activeSeconds: 20, meetingSeconds: 30, outsideChromeSeconds: 50 });
    checkInvariants(current!);
  });

  it('attributes each interval to the meeting state valid during it', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.tick(T0 + 10 * S);
    acc.setMeeting(true, T0 + 10 * S);
    acc.tick(T0 + 40 * S);
    acc.setMeeting(false, T0 + 45 * S);
    acc.tick(T0 + 70 * S);
    const { current } = acc.flush(T0 + 70 * S);
    expect(current).toMatchObject({ trackedSeconds: 70, activeSeconds: 0, meetingSeconds: 35 });
    expect(acc.inMeeting).toBe(false);
  });

  it('splits meeting seconds across a block boundary', () => {
    const acc = newAcc();
    const start = T0 + 580 * S;
    acc.setSession('s', start);
    acc.setFocus(WEB, start);
    acc.setMeeting(true, start);
    acc.tick(start + 30 * S);
    const { closed, current } = acc.flush(start + 30 * S);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ slotStart: T0, trackedSeconds: 20, meetingSeconds: 20 });
    expect(current).toMatchObject({ slotStart: T0 + SLOT_MS, trackedSeconds: 10, meetingSeconds: 10 });
  });

  it('does not count meeting time inside gaps > 90 s nor with the work day closed', () => {
    const acc = newAcc();
    acc.setSession('s', T0);
    acc.setFocus(WEB, T0);
    acc.setMeeting(true, T0);
    acc.tick(T0 + 30 * S);
    acc.tick(T0 + 200 * S); // 170 s gap: no data
    acc.tick(T0 + 230 * S);
    acc.setSession(null, T0 + 230 * S);
    acc.tick(T0 + 260 * S); // closed work day
    const { current } = acc.flush(T0 + 260 * S);
    expect(current).toMatchObject({ trackedSeconds: 60, meetingSeconds: 60 });
  });

  it('a meeting with the work day closed is kept as state and counts once it opens', () => {
    const acc = newAcc();
    acc.setMeeting(true, T0);
    acc.setFocus(WEB, T0);
    acc.tick(T0 + 20 * S);
    acc.setSession('s', T0 + 20 * S);
    acc.tick(T0 + 40 * S);
    expect(acc.flush(T0 + 40 * S).current).toMatchObject({ trackedSeconds: 20, meetingSeconds: 20 });
  });

  it('serializes meeting state and seconds (round trip gives identical results)', () => {
    const run = (split: boolean): ActivitySlot | null => {
      let acc = newAcc();
      acc.setSession('s', T0);
      acc.setFocus(WEB, T0);
      acc.setMeeting(true, T0);
      acc.tick(T0 + 20 * S);
      if (split) acc = SlotAccumulator.fromJSON(JSON.parse(JSON.stringify(acc.toJSON())));
      expect(acc.inMeeting).toBe(true);
      acc.markActiveSecond(T0 + 25 * S);
      acc.tick(T0 + 40 * S);
      return acc.flush(T0 + 40 * S).current;
    };
    expect(run(true)).toEqual(run(false));
    expect(run(false)).toMatchObject({ trackedSeconds: 40, activeSeconds: 1, meetingSeconds: 39 });
  });

  it('reads states saved before meetings existed (no meeting fields) as no meeting', () => {
    const acc = SlotAccumulator.fromJSON({
      v: 1,
      uid: UID,
      sessionId: 's',
      lastEventAt: T0 + 10 * S,
      idle: 'active',
      focus: { url: 'https://docs.google.com/d', domain: 'docs.google.com', measurable: true },
      closedUntil: 0,
      slots: [{ slotStart: T0, sessionId: 's', tracked: [0, 1, 2], active: [1], outside: 0, domains: {}, urls: {} }],
    });
    expect(acc.inMeeting).toBe(false);
    acc.tick(T0 + 20 * S);
    expect(acc.flush(T0 + 20 * S).current).toMatchObject({ trackedSeconds: 13, activeSeconds: 1, meetingSeconds: 0 });
    expect(acc.toJSON().meeting).toBe(false);
  });

  it('sanitizes corrupted meeting offsets', () => {
    const acc = SlotAccumulator.fromJSON({
      v: 1,
      uid: UID,
      sessionId: 's',
      lastEventAt: T0 + 10 * S,
      idle: 'active',
      focus: null,
      meeting: 'yes',
      closedUntil: 0,
      slots: [{ slotStart: T0, sessionId: 's', tracked: [0, 1, 2], active: [0], meeting: [0, 1, 5, 700, -1, 'x'], outside: 0, domains: {}, urls: {} }],
    });
    expect(acc.inMeeting).toBe(false);
    // 0 is active, 5 is not tracked: only second 1 is a meeting second.
    expect(acc.flush(T0 + 10 * S).current).toMatchObject({ trackedSeconds: 3, activeSeconds: 1, meetingSeconds: 1 });
  });

  it('rejects invalid timestamps', () => {
    expect(() => newAcc().setMeeting(true, Number.NaN)).toThrow(TypeError);
  });
});
