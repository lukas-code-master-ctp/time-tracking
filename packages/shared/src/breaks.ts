/**
 * "Pausa activa" (spec 2026-10-21-pausa-activa): settings in `config/org` and
 * the exercises the extension suggests. Shared by extension and portal.
 */
import { DEFAULT_TIME_ZONE } from './collections.js';
import { zonedDateTimeToMs } from './schedule.js';
import { ACTIVE_BREAK_EXERCISES, EXERCISE_ZONES, type ActiveBreakExercise } from './exercises.js';

/**
 * How the reminders are spread: `interval` after `intervalMinutes` of
 * continuous work; `daily` `perDay` times a day, spread over the working
 * hours of the day (spec 2026-10-22-pausa-activa-veces-al-dia); `times` at
 * the clock times the admin picks, the same for everyone (spec
 * 2026-11-10-pausa-activa-horas-fijas).
 */
export type ActiveBreakMode = 'interval' | 'daily' | 'times';

/** Settings of the active breaks of the organization. */
export interface ActiveBreakSettings {
  enabled: boolean;
  mode: ActiveBreakMode;
  /** Continuous work before a reminder (`interval`). */
  intervalMinutes: number;
  /** Reminders a day (`daily`). */
  perDay: number;
  /** Clock times of the reminders, "HH:MM" sorted (`times`; empty otherwise or when none is valid). */
  times: string[];
  /** How long the break lasts (also: away this long counts as a break). */
  durationMinutes: number;
}

/** Choices offered by the portal. */
export const ACTIVE_BREAK_INTERVAL_OPTIONS: readonly number[] = [45, 60, 90, 120];
export const ACTIVE_BREAK_DURATION_OPTIONS: readonly number[] = [3, 5, 10];
export const DEFAULT_ACTIVE_BREAK_INTERVAL_MINUTES = 60;
export const DEFAULT_ACTIVE_BREAK_MINUTES = 5;
export const ACTIVE_BREAK_PER_DAY_OPTIONS: readonly number[] = [2, 3, 4, 5, 6];
export const DEFAULT_ACTIVE_BREAKS_PER_DAY = 3;
/** Bounds accepted by firestore.rules (the portal only offers the options above). */
export const MIN_ACTIVE_BREAK_INTERVAL_MINUTES = 15;
export const MAX_ACTIVE_BREAK_INTERVAL_MINUTES = 240;
export const MIN_ACTIVE_BREAK_MINUTES = 1;
export const MAX_ACTIVE_BREAK_MINUTES = 15;
export const MIN_ACTIVE_BREAKS_PER_DAY = 1;
export const MAX_ACTIVE_BREAKS_PER_DAY = 12;
/** `times` mode: at most this many times a day (the rules accept the same). */
export const MAX_ACTIVE_BREAK_TIMES = 8;
/** Times offered when the admin picks `times` for the first time. */
export const DEFAULT_ACTIVE_BREAK_TIMES: readonly string[] = ['11:00', '16:00'];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" (24 h). */
export function isBreakTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v);
}

/** Valid times, without repeats, sorted; null when `v` is not a list of 1–8 valid times. */
export function normalizeBreakTimes(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every(isBreakTime)) return null;
  const out = [...new Set(v as string[])].sort();
  return out.length >= 1 && out.length <= MAX_ACTIVE_BREAK_TIMES ? out : null;
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Settings stored in a `config/org` document; missing or invalid fields = off / defaults. */
export function readActiveBreakSettings(config: unknown): ActiveBreakSettings {
  const c = (config && typeof config === 'object' ? config : {}) as {
    activeBreaksEnabled?: unknown;
    activeBreakMode?: unknown;
    activeBreakIntervalMinutes?: unknown;
    activeBreaksPerDay?: unknown;
    activeBreakTimes?: unknown;
    activeBreakMinutes?: unknown;
  };
  const times = normalizeBreakTimes(c.activeBreakTimes);
  return {
    enabled: c.activeBreaksEnabled === true,
    // `times` without valid times would never remind: back to the default.
    mode: c.activeBreakMode === 'daily' ? 'daily' : c.activeBreakMode === 'times' && times ? 'times' : 'interval',
    intervalMinutes: intIn(c.activeBreakIntervalMinutes, MIN_ACTIVE_BREAK_INTERVAL_MINUTES, MAX_ACTIVE_BREAK_INTERVAL_MINUTES)
      ? c.activeBreakIntervalMinutes
      : DEFAULT_ACTIVE_BREAK_INTERVAL_MINUTES,
    perDay: intIn(c.activeBreaksPerDay, MIN_ACTIVE_BREAKS_PER_DAY, MAX_ACTIVE_BREAKS_PER_DAY)
      ? c.activeBreaksPerDay
      : DEFAULT_ACTIVE_BREAKS_PER_DAY,
    times: times ?? [],
    durationMinutes: intIn(c.activeBreakMinutes, MIN_ACTIVE_BREAK_MINUTES, MAX_ACTIVE_BREAK_MINUTES)
      ? c.activeBreakMinutes
      : DEFAULT_ACTIVE_BREAK_MINUTES,
  };
}

/**
 * Instants of the `perDay` reminders of a day in `daily` mode: the working
 * time of `work` (the windows of the day, lunch excluded, in order) split in
 * `perDay + 1` equal parts; the i-th reminder at the end of the i-th part.
 * E.g. 9:00–18:00 with lunch 13:00–14:00 and 3 a day: 11:00, 14:00, 16:00.
 */
export function dailyBreakTargets(work: readonly { start: number; end: number }[], perDay: number): number[] {
  const total = work.reduce((sum, w) => sum + Math.max(0, w.end - w.start), 0);
  const n = Math.floor(perDay);
  if (!(total > 0) || !(n >= 1)) return [];
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    let left = Math.round((total * i) / (n + 1));
    for (const w of work) {
      const len = Math.max(0, w.end - w.start);
      if (left < len) {
        out.push(w.start + left);
        break;
      }
      left -= len;
    }
  }
  return out;
}

/** `times` mode: the instants of `times` on `date` (YYYY-MM-DD, in `timeZone`), in order. */
export function fixedBreakTargets(times: readonly string[], date: string, timeZone: string = DEFAULT_TIME_ZONE): number[] {
  return times.filter(isBreakTime).map((t) => zonedDateTimeToMs(date, t, timeZone));
}

/**
 * The reminders of `date` in the modes with a plan of the day (`daily`,
 * `times`; `[]` for `interval`): `at` the instant, `index` its position in
 * the plan (picks the exercise with `dailyExercise(date, index, planSize)`).
 * `work` = the working windows of the person that day.
 */
export function breakTargets(
  settings: Pick<ActiveBreakSettings, 'mode' | 'perDay' | 'times'>,
  work: readonly { start: number; end: number }[],
  date: string,
): { at: number; index: number }[] {
  if (settings.mode === 'daily') return dailyBreakTargets(work, settings.perDay).map((at, index) => ({ at, index }));
  if (settings.mode === 'times') return fixedBreakTargets(settings.times ?? [], date).map((at, index) => ({ at, index }));
  return [];
}

/** Breaks in the plan of the day (`daily`: `perDay`; `times`: the number of times). */
export function breakPlanSize(settings: Pick<ActiveBreakSettings, 'mode' | 'perDay' | 'times'>): number {
  if (settings.mode === 'times') return (settings.times ?? []).length;
  return settings.mode === 'daily' ? settings.perDay : 0;
}

/**
 * What to say after the exercise so it fills a break of `durationMinutes`:
 * the exercises take 1–2 minutes, the rest of the break is spelled out.
 */
export function breakClosing(durationMinutes: number): string {
  if (durationMinutes >= 10) return 'Repítelo 2 o 3 veces y luego camina unos minutos, toma agua y mira lejos de la pantalla.';
  if (durationMinutes >= 5) return 'Repítelo 2 veces y usa el resto para ponerte de pie, caminar y tomar agua.';
  if (durationMinutes >= 3) return 'Si te sobra tiempo, repítelo una vez más.';
  return '';
}

/** The instructions of `exercise` for a break of `durationMinutes` (its text plus `breakClosing`). */
export function exerciseInstructions(exercise: ActiveBreakExercise, durationMinutes: number): string {
  const closing = breakClosing(durationMinutes);
  return closing ? `${exercise.text} ${closing}` : exercise.text;
}

/** Small deterministic PRNG (mulberry32): the same seed gives the same shuffle on every device. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BY_ZONE: readonly (readonly ActiveBreakExercise[])[] = EXERCISE_ZONES.map((z) =>
  ACTIVE_BREAK_EXERCISES.filter((e) => e.zone === z.id),
);
const ROUND = EXERCISE_ZONES.length;
const CYCLE = ACTIVE_BREAK_EXERCISES.length;

/** The order of the exercises of zone `z` in cycle `c` (a seeded shuffle). */
function zoneOrder(c: number, z: number): readonly ActiveBreakExercise[] {
  const list = [...BY_ZONE[z]!];
  const next = random(c * 7919 + z * 104729 + 1);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

const orders = new Map<string, readonly ActiveBreakExercise[]>();
/**
 * `zoneOrder` without repeating across cycles: the first two of a cycle are
 * never the last two of the cycle before (those stay in place, so the check
 * against the plain shuffle of the cycle before holds).
 */
function cycleZone(c: number, z: number): readonly ActiveBreakExercise[] {
  const key = `${c}:${z}`;
  const hit = orders.get(key);
  if (hit) return hit;
  const raw = zoneOrder(c, z);
  const before = zoneOrder(c - 1, z);
  const tail = new Set(before.slice(-2));
  const front = raw.filter((e) => !tail.has(e)).slice(0, 2);
  const list = [...front, ...raw.filter((e) => !front.includes(e))];
  if (orders.size > 512) orders.clear();
  orders.set(key, list);
  return list;
}

/**
 * The exercise of the `n`-th reminder. The rotation goes through all the
 * exercises (a "cycle", shuffled differently each time) before repeating
 * one, visiting the zones always in the order of `EXERCISE_ZONES`: any 7
 * reminders in a row are of 7 different zones.
 */
export function exerciseAt(n: number): ActiveBreakExercise {
  const i = Math.floor(n);
  const c = Math.floor(i / CYCLE);
  const k = i - c * CYCLE;
  return cycleZone(c, k % ROUND)[Math.floor(k / ROUND)]!;
}

/**
 * `daily` mode: the exercise of the `index`-th reminder (0-based) of `date`
 * (YYYY-MM-DD). The same for everyone, so the portal can show the plan of
 * the day; it keeps rotating from one day to the next.
 */
export function dailyExercise(date: string, index: number, perDay: number): ActiveBreakExercise {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return exerciseAt(day * Math.max(1, Math.floor(perDay)) + index);
}

/** Exercise by id (unknown ids, e.g. from a newer version: null). */
export function exerciseById(id: string): ActiveBreakExercise | null {
  return ACTIVE_BREAK_EXERCISES.find((e) => e.id === id) ?? null;
}
