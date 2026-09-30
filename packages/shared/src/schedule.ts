/**
 * Working hours, lunch and compliance (spec 2026-09-30-horarios.md). Pure.
 *
 * Times of a schedule are wall-clock `HH:MM` (24 h) in America/Santiago and
 * dates are `YYYY-MM-DD` in the same zone. They become instants (ms) with
 * {@link zonedDateTimeToMs}.
 *
 * Daylight saving time. Chile changes its clock at midnight:
 * - in September 00:00 jumps to 01:00, so 00:00–00:59 of that Sunday does not
 *   exist (the day lasts 23 h);
 * - in April 24:00 goes back to 23:00, so 23:00–23:59 of that Saturday happens
 *   twice (the day lasts 25 h).
 * Resolution (the same as the portal's `startOfDay`, which looks for the first
 * instant of a date): a wall-clock time is the **first instant at which the
 * clock shows that time or a later one** on that date. So a time that does not
 * exist becomes the instant of the jump (00:30 → 01:00 new time), and a
 * repeated time is its first occurrence (23:30 → the one before going back).
 * Work days never cross midnight, so in practice only a schedule starting in
 * 00:00–00:59 on the September day, or ending in 23:00–23:59 on the April day,
 * is affected.
 */

import { DEFAULT_TIME_ZONE, dateKey } from './collections.js';
import type {
  DaySchedule,
  EpochMs,
  PersonSchedule,
  ScheduleConfig,
  Session,
  WeekSchedule,
  Weekday,
} from './types.js';

// ---------- constants ----------

/** Monday first (index 0), as in the portal's `weekdayIndex`. */
export const WEEKDAYS: readonly Weekday[] = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = Object.freeze({
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
});

export const MAX_HOLIDAYS = 60;
export const DEFAULT_TOLERANCE_MINUTES = 5;
export const MAX_TOLERANCE_MINUTES = 60;

/** `HH:MM`, 00:00–23:59. Same pattern as `firestore.rules`. */
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// ---------- times and dates ----------

export function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** Minutes since 00:00 of a valid `HH:MM`. */
export function timeToMinutes(time: string): number {
  if (!isValidTime(time)) throw new Error(`Hora inválida: ${time}`);
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_KEY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parseDateKey(date: string): { y: number; m: number; d: number } {
  if (!isValidDateKey(date)) throw new Error(`Fecha inválida: ${date}`);
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) };
}

/** Calendar arithmetic on `YYYY-MM-DD` (independent of any zone). */
export function addDaysToDateKey(date: string, days: number): string {
  const { y, m, d } = parseDateKey(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Weekday of a calendar date. */
export function weekdayOfDateKey(date: string): Weekday {
  const { y, m, d } = parseDateKey(date);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = wallFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallFormatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock time shown in the zone at `ms`, written as if it were UTC (second precision). */
function wallClockAsUtc(ms: number, timeZone: string): number {
  const parts = wallFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/**
 * Instant (ms) of the wall-clock time `time` (`HH:MM`) on `date` in the zone.
 * A time skipped by a clock change resolves to the instant of the change; a
 * repeated time to its first occurrence (see the header).
 */
export function zonedDateTimeToMs(date: string, time: string, timeZone: string = DEFAULT_TIME_ZONE): EpochMs {
  // Memoized: Intl is slow (a team report of 30 people × 93 days converts the
  // same few dates and times thousands of times) and the result never changes.
  const key = `${timeZone}|${date}|${time}`;
  const hit = zonedCache.get(key);
  if (hit !== undefined) return hit;
  const ms = computeZonedDateTimeToMs(date, time, timeZone);
  if (zonedCache.size >= ZONED_CACHE_MAX) zonedCache.clear();
  zonedCache.set(key, ms);
  return ms;
}

const ZONED_CACHE_MAX = 20_000;
const zonedCache = new Map<string, number>();

function computeZonedDateTimeToMs(date: string, time: string, timeZone: string): EpochMs {
  const { y, m, d } = parseDateKey(date);
  const minutes = timeToMinutes(time);
  const target = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Offsets a day before and after: at most one clock change lies in between.
  const offsets = [target - DAY_MS, target + DAY_MS].map((x) => wallClockAsUtc(x, timeZone) - x);
  const candidates = [...new Set(offsets.map((o) => target - o))].sort((a, b) => a - b);
  const valid = candidates.filter((c) => wallClockAsUtc(c, timeZone) === target);
  if (valid.length > 0) return valid[0]!;
  if (candidates.length === 1) return candidates[0]!;
  // Skipped time: the first instant whose wall clock reaches `target`.
  let lo = candidates[0]!;
  let hi = candidates[candidates.length - 1]!;
  // Invariant: wall(lo) < target <= wall(hi).
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallClockAsUtc(mid, timeZone) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** First instant of `date` in the zone (same result as the portal's `startOfDay`). */
export function startOfZonedDay(date: string, timeZone: string = DEFAULT_TIME_ZONE): EpochMs {
  return zonedDateTimeToMs(date, '00:00', timeZone);
}

export interface Interval {
  /** Inclusive (ms). */
  start: EpochMs;
  /** Exclusive (ms). */
  end: EpochMs;
}

/** `[start of date, start of the next date)` */
export function zonedDayBounds(date: string, timeZone: string = DEFAULT_TIME_ZONE): Interval {
  return { start: startOfZonedDay(date, timeZone), end: startOfZonedDay(addDaysToDateKey(date, 1), timeZone) };
}

// ---------- validation ----------

/** One validation problem, with a Spanish message for the portal. */
export interface ScheduleIssue {
  /** Where: `week.mon.start`, `holidays[3]`, `toleranceMinutes`… */
  path: string;
  message: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const DAY_KEYS = ['start', 'end', 'lunchStart', 'lunchEnd'];

/** Problems of one day (`null` = day off, always valid). */
export function validateDaySchedule(day: unknown, weekday: Weekday, path = `week.${weekday}`): ScheduleIssue[] {
  if (day === null) return [];
  const name = WEEKDAY_NAMES[weekday];
  if (!isPlainObject(day)) return [{ path, message: `${name}: el horario no es válido.` }];
  const issues: ScheduleIssue[] = [];
  const extra = Object.keys(day).filter((k) => !DAY_KEYS.includes(k));
  if (extra.length > 0) issues.push({ path, message: `${name}: campos no permitidos (${extra.join(', ')}).` });
  const { start, end, lunchStart, lunchEnd } = day;
  const startOk = isValidTime(start);
  const endOk = isValidTime(end);
  if (!startOk) issues.push({ path: `${path}.start`, message: `${name}: la hora de entrada debe tener formato HH:MM (24 h).` });
  if (!endOk) issues.push({ path: `${path}.end`, message: `${name}: la hora de salida debe tener formato HH:MM (24 h).` });
  if (startOk && endOk && start >= end) {
    issues.push({ path: `${path}.end`, message: `${name}: la salida debe ser posterior a la entrada (sin cruzar la medianoche).` });
  }
  const lsNull = lunchStart === null;
  const leNull = lunchEnd === null;
  if (lsNull && leNull) return issues;
  if (lsNull !== leNull) {
    issues.push({ path: `${path}.lunchStart`, message: `${name}: la colación necesita inicio y término, o ninguno de los dos.` });
    return issues;
  }
  const lsOk = isValidTime(lunchStart);
  const leOk = isValidTime(lunchEnd);
  if (!lsOk) issues.push({ path: `${path}.lunchStart`, message: `${name}: el inicio de la colación debe tener formato HH:MM (24 h).` });
  if (!leOk) issues.push({ path: `${path}.lunchEnd`, message: `${name}: el término de la colación debe tener formato HH:MM (24 h).` });
  if (!lsOk || !leOk) return issues;
  if (lunchStart >= lunchEnd) {
    issues.push({ path: `${path}.lunchEnd`, message: `${name}: el término de la colación debe ser posterior a su inicio.` });
  } else if (startOk && endOk && start < end && (lunchStart < start || lunchEnd > end)) {
    issues.push({ path: `${path}.lunchStart`, message: `${name}: la colación debe quedar dentro del horario (${start}–${end}).` });
  }
  return issues;
}

/** Problems of a week: exactly the 7 days, each valid or `null`. */
export function validateWeekSchedule(week: unknown, path = 'week'): ScheduleIssue[] {
  if (!isPlainObject(week)) return [{ path, message: 'El horario semanal no es válido.' }];
  const issues: ScheduleIssue[] = [];
  const extra = Object.keys(week).filter((k) => !(WEEKDAYS as readonly string[]).includes(k));
  if (extra.length > 0) issues.push({ path, message: `El horario semanal tiene días desconocidos (${extra.join(', ')}).` });
  for (const wd of WEEKDAYS) {
    if (!(wd in week)) {
      issues.push({ path: `${path}.${wd}`, message: `${WEEKDAY_NAMES[wd]}: falta el horario (usa "libre" si no se trabaja).` });
      continue;
    }
    issues.push(...validateDaySchedule(week[wd], wd, `${path}.${wd}`));
  }
  return issues;
}

/** Problems of the holiday list: valid dates, unique, at most 60. */
export function validateHolidays(holidays: unknown, path = 'holidays'): ScheduleIssue[] {
  if (!Array.isArray(holidays)) return [{ path, message: 'La lista de feriados no es válida.' }];
  const issues: ScheduleIssue[] = [];
  if (holidays.length > MAX_HOLIDAYS) {
    issues.push({ path, message: `Puedes guardar hasta ${MAX_HOLIDAYS} feriados (hay ${holidays.length}). Quita los de años pasados.` });
  }
  const seen = new Set<string>();
  holidays.forEach((h, i) => {
    if (!isValidDateKey(h)) {
      issues.push({ path: `${path}[${i}]`, message: `Feriado ${i + 1}: la fecha debe tener formato AAAA-MM-DD.` });
    } else if (seen.has(h)) {
      issues.push({ path: `${path}[${i}]`, message: `El feriado ${h} está repetido.` });
    } else {
      seen.add(h);
    }
  });
  return issues;
}

export function validateToleranceMinutes(value: unknown, path = 'toleranceMinutes'): ScheduleIssue[] {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TOLERANCE_MINUTES) {
    return [{ path, message: `La tolerancia debe ser un número entero de minutos entre 0 y ${MAX_TOLERANCE_MINUTES}.` }];
  }
  return [];
}

const CONFIG_KEYS = ['week', 'holidays', 'toleranceMinutes', 'remindersEnabled', 'updatedAt', 'updatedBy'];
const PERSON_KEYS = ['week', 'updatedAt', 'updatedBy'];

function validateMeta(doc: Record<string, unknown>, allowed: readonly string[]): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const extra = Object.keys(doc).filter((k) => !allowed.includes(k));
  if (extra.length > 0) issues.push({ path: '', message: `Campos no permitidos: ${extra.join(', ')}.` });
  if (typeof doc.updatedAt !== 'number' || !Number.isSafeInteger(doc.updatedAt) || doc.updatedAt < 0) {
    issues.push({ path: 'updatedAt', message: 'Falta la fecha de actualización.' });
  }
  if (typeof doc.updatedBy !== 'string' || doc.updatedBy === '') {
    issues.push({ path: 'updatedBy', message: 'Falta quién hizo el cambio.' });
  }
  return issues;
}

/** Problems of a `config/schedule` document ([] = valid). */
export function validateScheduleConfig(doc: unknown): ScheduleIssue[] {
  if (!isPlainObject(doc)) return [{ path: '', message: 'El horario no es válido.' }];
  const issues = [
    ...validateWeekSchedule(doc.week),
    ...validateHolidays(doc.holidays),
    ...validateToleranceMinutes(doc.toleranceMinutes),
  ];
  if (typeof doc.remindersEnabled !== 'boolean') {
    issues.push({ path: 'remindersEnabled', message: 'Indica si los recordatorios están activados.' });
  }
  return [...issues, ...validateMeta(doc, CONFIG_KEYS)];
}

/** Problems of a `schedules/{uid}` document ([] = valid). */
export function validatePersonSchedule(doc: unknown): ScheduleIssue[] {
  if (!isPlainObject(doc)) return [{ path: '', message: 'El horario no es válido.' }];
  return [...validateWeekSchedule(doc.week), ...validateMeta(doc, PERSON_KEYS)];
}

function cleanWeek(week: Record<string, unknown>): WeekSchedule {
  const out = {} as WeekSchedule;
  for (const wd of WEEKDAYS) {
    const d = week[wd] as DaySchedule | null;
    out[wd] = d === null ? null : { start: d.start, end: d.end, lunchStart: d.lunchStart, lunchEnd: d.lunchEnd };
  }
  return out;
}

/** A valid `config/schedule` read from Firestore (a clean copy), or null. */
export function readScheduleConfig(raw: unknown): ScheduleConfig | null {
  if (!isPlainObject(raw)) return null;
  // The rules check the format of the holidays but not the calendar (they
  // accept 2026-02-30): drop such a date instead of ignoring the whole
  // schedule (which would make the extension measure at every hour).
  const holidays = Array.isArray(raw.holidays)
    ? raw.holidays.filter((h) => typeof h !== 'string' || !DATE_KEY_RE.test(h) || isValidDateKey(h))
    : raw.holidays;
  if (validateScheduleConfig({ ...raw, holidays }).length > 0) return null;
  const d = raw as Record<string, unknown>;
  return {
    week: cleanWeek(d.week as Record<string, unknown>),
    holidays: [...(holidays as string[])],
    toleranceMinutes: d.toleranceMinutes as number,
    remindersEnabled: d.remindersEnabled as boolean,
    updatedAt: d.updatedAt as number,
    updatedBy: d.updatedBy as string,
  };
}

/** A valid `schedules/{uid}` read from Firestore (a clean copy), or null. */
export function readPersonSchedule(raw: unknown): PersonSchedule | null {
  if (validatePersonSchedule(raw).length > 0) return null;
  const d = raw as Record<string, unknown>;
  return { week: cleanWeek(d.week as Record<string, unknown>), updatedAt: d.updatedAt as number, updatedBy: d.updatedBy as string };
}

/** A week with every day off. */
export function emptyWeek(): WeekSchedule {
  return { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
}

/** Holidays unique and sorted (for saving). */
export function normalizeHolidays(holidays: readonly string[]): string[] {
  return [...new Set(holidays.filter((h) => isValidDateKey(h)))].sort();
}

// ---------- schedule of a day ----------

/** The person's week: the exception when there is one, otherwise the general one (or null = no schedule). */
export function effectiveWeek(
  org: Pick<ScheduleConfig, 'week'> | null | undefined,
  override: Pick<PersonSchedule, 'week'> | null | undefined,
): WeekSchedule | null {
  return override?.week ?? org?.week ?? null;
}

/** Schedule of `date` (null on a day off or a holiday). */
export function dayScheduleFor(
  date: string,
  week: WeekSchedule | null,
  holidays: readonly string[],
): DaySchedule | null {
  if (!week || holidays.includes(date)) return null;
  return week[weekdayOfDateKey(date)] ?? null;
}

export interface DayPlan {
  date: string;
  weekday: Weekday;
  holiday: boolean;
  schedule: DaySchedule | null;
  /** Entry → exit (lunch included), or null on a day off. */
  span: Interval | null;
  /** Working windows without the lunch (0, 1 or 2). */
  work: Interval[];
  lunch: Interval | null;
}

/** Instants of the schedule of `date`. */
export function planForDay(
  date: string,
  week: WeekSchedule | null,
  holidays: readonly string[],
  timeZone: string = DEFAULT_TIME_ZONE,
): DayPlan {
  const weekday = weekdayOfDateKey(date);
  const holiday = holidays.includes(date);
  const schedule = dayScheduleFor(date, week, holidays);
  if (!schedule) return { date, weekday, holiday, schedule: null, span: null, work: [], lunch: null };
  const at = (t: string): number => zonedDateTimeToMs(date, t, timeZone);
  const span = { start: at(schedule.start), end: at(schedule.end) };
  if (schedule.lunchStart === null || schedule.lunchEnd === null) {
    return { date, weekday, holiday, schedule, span, work: span.end > span.start ? [span] : [], lunch: null };
  }
  const lunch = { start: at(schedule.lunchStart), end: at(schedule.lunchEnd) };
  const work = [
    { start: span.start, end: lunch.start },
    { start: lunch.end, end: span.end },
  ].filter((w) => w.end > w.start);
  return { date, weekday, holiday, schedule, span, work, lunch: lunch.end > lunch.start ? lunch : null };
}

/** Working windows of `date` in ms, without the lunch; `[]` on a day off or a holiday. */
export function windowsForDay(
  date: string,
  week: WeekSchedule | null,
  holidays: readonly string[],
  timeZone: string = DEFAULT_TIME_ZONE,
): Interval[] {
  return planForDay(date, week, holidays, timeZone).work;
}

export type ScheduleState = 'work' | 'lunch' | 'off';

/** Whether `ms` falls in working hours, in the lunch or outside the schedule. */
export function classifyInstant(
  ms: number,
  week: WeekSchedule | null,
  holidays: readonly string[],
  timeZone: string = DEFAULT_TIME_ZONE,
): ScheduleState {
  const plan = planForDay(dateKey(ms, timeZone), week, holidays, timeZone);
  if (plan.work.some((w) => ms >= w.start && ms < w.end)) return 'work';
  if (plan.lunch && ms >= plan.lunch.start && ms < plan.lunch.end) return 'lunch';
  return 'off';
}

// ---------- compliance ----------

interface Piece extends Interval {
  /** The piece ends where an open session is still running (its last heartbeat). */
  open: boolean;
}

/**
 * Connected time: the union of the sessions (overlapping sessions count
 * once). Like `reports.ts`, an open session lasts until its last heartbeat,
 * and nothing counts after `now`.
 */
function connectedPieces(sessions: readonly Session[], now: number): Piece[] {
  const raw: Piece[] = [];
  for (const s of sessions) {
    const end = Math.min(s.endedAt ?? s.lastHeartbeatAt, now);
    if (end > s.startedAt) raw.push({ start: s.startedAt, end, open: s.endedAt === null });
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Piece[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && p.start <= last.end) {
      if (p.end > last.end) {
        last.end = p.end;
        last.open = p.open;
      } else if (p.end === last.end) {
        last.open ||= p.open;
      }
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

function overlapMs(pieces: readonly Interval[], w: Interval): number {
  let total = 0;
  for (const p of pieces) {
    const s = Math.max(p.start, w.start);
    const e = Math.min(p.end, w.end);
    if (e > s) total += e - s;
  }
  return total;
}

function clip(pieces: readonly Piece[], w: Interval): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const s = Math.max(p.start, w.start);
    const e = Math.min(p.end, w.end);
    if (e > s) out.push({ start: s, end: e, open: p.open && e === p.end });
  }
  return out;
}

const sec = (ms: number): number => Math.floor(Math.max(0, ms) / 1000);

export interface DayCompliance {
  date: string;
  weekday: Weekday;
  /** The date is in the holiday list. */
  holiday: boolean;
  /** It has working hours (not a day off nor a holiday). */
  workday: boolean;
  scheduledStart: EpochMs | null;
  scheduledEnd: EpochMs | null;
  /**
   * `now` against the schedule (entry → exit) on a workday, or against the
   * calendar day otherwise. Absence and early leave are only decided once
   * the day is `finished`.
   */
  state: 'upcoming' | 'ongoing' | 'finished';
  /** Sum of the working windows (lunch excluded). */
  expectedSeconds: number;
  /** Part of `expectedSeconds` before `now`. */
  expectedSoFarSeconds: number;
  /** Session time on this calendar day (sessions crossing midnight are split). */
  connectedSeconds: number;
  /** Session time inside the working windows. */
  inScheduleSeconds: number;
  /** Session time during the lunch. */
  lunchSeconds: number;
  /** Session time outside the windows and the lunch (all of it on a day off). */
  outsideScheduleSeconds: number;
  /** `expectedSoFarSeconds - inScheduleSeconds`. */
  offlineSeconds: number;
  /** First connected instant between entry and exit, or null. */
  arrivalAt: EpochMs | null;
  /** Last connected instant between entry and exit, or null. */
  departureAt: EpochMs | null;
  /** `arrivalAt - entry` when it exceeds the tolerance (the whole delay), otherwise 0. */
  lateSeconds: number;
  late: boolean;
  /** `exit - departureAt` when it exceeds the tolerance, the day is finished and the session is closed; otherwise 0. */
  earlyLeaveSeconds: number;
  earlyLeave: boolean;
  /** Finished workday without any session time on it. */
  absent: boolean;
}

/**
 * Compliance of one person on `date`. `sessions` must be that person's (any
 * range: only the part on `date` counts). `week` null = no schedule (every
 * day off).
 *
 * Edge cases:
 * - time before the entry or after the exit counts as outside the schedule;
 * - the lunch is neither worked nor outside the schedule (`lunchSeconds`);
 * - several sessions are merged (overlaps count once);
 * - a session crossing midnight counts on each day for its part;
 * - on a day off or a holiday everything is outside the schedule;
 * - lateness uses the first instant connected between entry and exit: a
 *   session that started before the entry and was still open at the entry is
 *   on time; one that ended before the entry does not count as arrival;
 * - an open session that has not reached the exit is not an early leave (the
 *   person is still working, or it will be closed automatically).
 */
export function complianceForDay(
  date: string,
  sessions: readonly Session[],
  week: WeekSchedule | null,
  holidays: readonly string[],
  toleranceMinutes: number,
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): DayCompliance {
  return complianceFromPieces(date, connectedPieces(sessions, now), week, holidays, toleranceMinutes, now, timeZone);
}

function complianceFromPieces(
  date: string,
  connected: readonly Piece[],
  week: WeekSchedule | null,
  holidays: readonly string[],
  toleranceMinutes: number,
  now: number,
  timeZone: string,
): DayCompliance {
  const plan = planForDay(date, week, holidays, timeZone);
  const day = zonedDayBounds(date, timeZone);
  const pieces = clip(connected, day);
  const toleranceMs = Math.max(0, toleranceMinutes) * 60_000;

  const connectedMs = overlapMs(pieces, day);
  const inMs = plan.work.reduce((t, w) => t + overlapMs(pieces, w), 0);
  const lunchMs = plan.lunch ? overlapMs(pieces, plan.lunch) : 0;
  const expectedMs = plan.work.reduce((t, w) => t + (w.end - w.start), 0);
  const expectedSoFarMs = plan.work.reduce((t, w) => t + Math.max(0, Math.min(w.end, now) - w.start), 0);

  const bounds = plan.span ?? day;
  const state = now < bounds.start ? 'upcoming' : now >= bounds.end ? 'finished' : 'ongoing';

  let arrivalAt: number | null = null;
  let departureAt: number | null = null;
  let lateSeconds = 0;
  let earlyLeaveSeconds = 0;
  if (plan.span) {
    const inSpan = clip(pieces, plan.span);
    const first = inSpan[0];
    const last = inSpan[inSpan.length - 1];
    if (first && last) {
      arrivalAt = first.start;
      departureAt = last.end;
      const delay = arrivalAt - plan.span.start;
      if (delay > toleranceMs) lateSeconds = sec(delay);
      const early = plan.span.end - departureAt;
      if (state === 'finished' && !last.open && early > toleranceMs) earlyLeaveSeconds = sec(early);
    }
  }

  const inScheduleSeconds = sec(inMs);
  const lunchSeconds = sec(lunchMs);
  const expectedSoFarSeconds = sec(expectedSoFarMs);
  return {
    date,
    weekday: plan.weekday,
    holiday: plan.holiday,
    workday: plan.work.length > 0,
    scheduledStart: plan.span?.start ?? null,
    scheduledEnd: plan.span?.end ?? null,
    state,
    expectedSeconds: sec(expectedMs),
    expectedSoFarSeconds,
    connectedSeconds: sec(connectedMs),
    inScheduleSeconds,
    lunchSeconds,
    outsideScheduleSeconds: sec(connectedMs - inMs - lunchMs),
    offlineSeconds: Math.max(0, expectedSoFarSeconds - inScheduleSeconds),
    arrivalAt,
    departureAt,
    lateSeconds,
    late: lateSeconds > 0,
    earlyLeaveSeconds,
    earlyLeave: earlyLeaveSeconds > 0,
    absent: plan.work.length > 0 && state === 'finished' && connectedMs === 0,
  };
}

export interface ComplianceTotals {
  days: number;
  workdays: number;
  expectedSeconds: number;
  expectedSoFarSeconds: number;
  connectedSeconds: number;
  inScheduleSeconds: number;
  lunchSeconds: number;
  outsideScheduleSeconds: number;
  offlineSeconds: number;
  lateCount: number;
  lateSeconds: number;
  earlyLeaveCount: number;
  earlyLeaveSeconds: number;
  absentDays: number;
}

/** Sum of several days. */
export function sumCompliance(days: readonly DayCompliance[]): ComplianceTotals {
  const t: ComplianceTotals = {
    days: 0,
    workdays: 0,
    expectedSeconds: 0,
    expectedSoFarSeconds: 0,
    connectedSeconds: 0,
    inScheduleSeconds: 0,
    lunchSeconds: 0,
    outsideScheduleSeconds: 0,
    offlineSeconds: 0,
    lateCount: 0,
    lateSeconds: 0,
    earlyLeaveCount: 0,
    earlyLeaveSeconds: 0,
    absentDays: 0,
  };
  for (const d of days) {
    t.days++;
    if (d.workday) t.workdays++;
    t.expectedSeconds += d.expectedSeconds;
    t.expectedSoFarSeconds += d.expectedSoFarSeconds;
    t.connectedSeconds += d.connectedSeconds;
    t.inScheduleSeconds += d.inScheduleSeconds;
    t.lunchSeconds += d.lunchSeconds;
    t.outsideScheduleSeconds += d.outsideScheduleSeconds;
    t.offlineSeconds += d.offlineSeconds;
    if (d.late) t.lateCount++;
    t.lateSeconds += d.lateSeconds;
    if (d.earlyLeave) t.earlyLeaveCount++;
    t.earlyLeaveSeconds += d.earlyLeaveSeconds;
    if (d.absent) t.absentDays++;
  }
  return t;
}

/** Longest range accepted by {@link complianceForRange}. */
export const MAX_COMPLIANCE_RANGE_DAYS = 400;

export interface RangeCompliance {
  days: DayCompliance[];
  totals: ComplianceTotals;
}

/** Compliance for every date `fromDate..toDate` (inclusive; swapped if reversed). */
export function complianceForRange(
  fromDate: string,
  toDate: string,
  sessions: readonly Session[],
  week: WeekSchedule | null,
  holidays: readonly string[],
  toleranceMinutes: number,
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): RangeCompliance {
  const [a, b] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
  parseDateKey(a);
  parseDateKey(b);
  const days: DayCompliance[] = [];
  const connected = connectedPieces(sessions, now);
  for (let d = a; d <= b; d = addDaysToDateKey(d, 1)) {
    if (days.length >= MAX_COMPLIANCE_RANGE_DAYS) {
      throw new RangeError(`El rango supera ${MAX_COMPLIANCE_RANGE_DAYS} días.`);
    }
    days.push(complianceFromPieces(d, connected, week, holidays, toleranceMinutes, now, timeZone));
  }
  return { days, totals: sumCompliance(days) };
}
