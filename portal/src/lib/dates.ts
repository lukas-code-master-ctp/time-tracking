/**
 * Calendar dates and ranges in an IANA time zone (America/Santiago by default).
 *
 * A "date" is a `YYYY-MM-DD` string (the calendar day in the zone). A range is
 * the half-open interval of instants `[from, to)` covering whole days, which is
 * what the Firestore queries (`slotStart`, `startedAt`, `takenAt`) use.
 *
 * Chile changes its clock at midnight (e.g. 2026-09-06 00:00 → 01:00), so a
 * day does not always start at 00:00 nor last 24 h: day starts are found by
 * searching the first instant whose date is the wanted one, never by adding
 * 24 h.
 */
import { DEFAULT_TIME_ZONE } from '@timetracking/shared';

export type RangePreset = 'today' | 'yesterday' | 'thisWeek' | 'last7' | 'thisMonth' | 'custom';

export interface DateRange {
  preset: RangePreset;
  /** First day (inclusive), `YYYY-MM-DD`. */
  fromDate: string;
  /** Last day (inclusive), `YYYY-MM-DD`. */
  toDate: string;
  /** Start of `fromDate` (ms, inclusive). */
  from: number;
  /** Start of the day after `toDate` (ms, exclusive). */
  to: number;
  /** Custom range longer than MAX_CUSTOM_RANGE_DAYS: `fromDate` was moved forward. */
  clamped?: boolean;
}

/**
 * Longest custom range (about a quarter). A month for 30 people is already
 * ~30 000 `activity` reads; beyond ~3 months the portal gets slow and costly.
 */
export const MAX_CUSTOM_RANGE_DAYS = 93;

export const RANGE_PRESETS: readonly { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: 'thisWeek', label: 'Esta semana' },
  { value: 'last7', label: 'Últimos 7 días' },
  { value: 'thisMonth', label: 'Este mes' },
  { value: 'custom', label: 'Personalizado' },
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_MS = 3_600_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  date: string;
  hour: number;
  minute: number;
}

/** Wall-clock date and time of an instant in the zone. */
export function zonedParts(ms: number, timeZone: string = DEFAULT_TIME_ZONE): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

/** Calendar date (`YYYY-MM-DD`) of an instant in the zone. */
export function zonedDate(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  return zonedParts(ms, timeZone).date;
}

/** `HH:MM` wall-clock time of an instant in the zone. */
export function formatTime(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date);
  if (!m || !isValidDate(date)) throw new Error(`Fecha inválida: ${date}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function fromUtcDate(t: Date): string {
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Calendar arithmetic (independent of any zone). */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDate(date);
  return fromUtcDate(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Whole calendar days from `a` to `b` (`b - a`; negative if `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: string): number {
  const { y, m, d } = parseDate(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** First instant (ms) whose calendar date in the zone is `date`. */
export function startOfDay(date: string, timeZone: string = DEFAULT_TIME_ZONE): number {
  const { y, m, d } = parseDate(date);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Every UTC offset in use lies within [-12 h, +14 h]: the day starts in this window.
  let lo = utcMidnight - 15 * HOUR_MS;
  let hi = utcMidnight + 13 * HOUR_MS;
  // Invariant: zonedDate(lo) < date <= zonedDate(hi). Dates are monotonic in time.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zonedDate(mid, timeZone) < date) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** `[startOfDay(date), startOfDay(date + 1))` */
export function dayBounds(date: string, timeZone: string = DEFAULT_TIME_ZONE): { from: number; to: number } {
  return { from: startOfDay(date, timeZone), to: startOfDay(addDays(date, 1), timeZone) };
}

/** Range covering the whole days `fromDate..toDate` (inclusive; swapped if reversed). */
export function rangeOfDates(
  fromDate: string,
  toDate: string,
  preset: RangePreset = 'custom',
  timeZone: string = DEFAULT_TIME_ZONE,
): DateRange {
  const [a, b] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
  return {
    preset,
    fromDate: a,
    toDate: b,
    from: startOfDay(a, timeZone),
    to: startOfDay(addDays(b, 1), timeZone),
  };
}

/** Range of a preset relative to `now`. `custom` needs `fromDate`/`toDate` (defaults to today). */
export function presetRange(
  preset: RangePreset,
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
  custom?: { fromDate: string; toDate: string },
): DateRange {
  const today = zonedDate(now, timeZone);
  switch (preset) {
    case 'today':
      return rangeOfDates(today, today, preset, timeZone);
    case 'yesterday': {
      const y = addDays(today, -1);
      return rangeOfDates(y, y, preset, timeZone);
    }
    case 'thisWeek': {
      const monday = addDays(today, -weekdayIndex(today));
      return rangeOfDates(monday, addDays(monday, 6), preset, timeZone);
    }
    case 'last7':
      return rangeOfDates(addDays(today, -6), today, preset, timeZone);
    case 'thisMonth': {
      const first = `${today.slice(0, 8)}01`;
      const nextFirst = addDays(first, 32).slice(0, 8) + '01';
      return rangeOfDates(first, addDays(nextFirst, -1), preset, timeZone);
    }
    case 'custom': {
      const fromDate = custom && isValidDate(custom.fromDate) ? custom.fromDate : today;
      const toDate = custom && isValidDate(custom.toDate) ? custom.toDate : fromDate;
      const [a, b] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate];
      // Inclusive length a..b; keep the end and move the start forward.
      if (daysBetween(a, b) + 1 > MAX_CUSTOM_RANGE_DAYS) {
        return { ...rangeOfDates(addDays(b, -(MAX_CUSTOM_RANGE_DAYS - 1)), b, preset, timeZone), clamped: true };
      }
      return rangeOfDates(a, b, preset, timeZone);
    }
  }
}

export function isRangePreset(value: string | null | undefined): value is RangePreset {
  return RANGE_PRESETS.some((p) => p.value === value);
}

/** True when `now` falls inside the range (the data may still change). */
export function rangeIncludes(range: { from: number; to: number }, now: number): boolean {
  return now >= range.from && now < range.to;
}

const longDate = new Map<string, Intl.DateTimeFormat>();

/** "martes, 29 de septiembre de 2026" */
export function formatLongDate(date: string): string {
  const { y, m, d } = parseDate(date);
  let f = longDate.get('es');
  if (!f) {
    f = new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    longDate.set('es', f);
  }
  return f.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "29-09-2026" (day-first, as used in Chile). */
export function formatShortDate(date: string): string {
  const { y, m, d } = parseDate(date);
  return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;
}

/** Human label of a range: "Hoy", "29-09-2026", "01-09-2026 – 30-09-2026". */
export function describeRange(range: DateRange): string {
  if (range.fromDate === range.toDate) return formatShortDate(range.fromDate);
  return `${formatShortDate(range.fromDate)} – ${formatShortDate(range.toDate)}`;
}

/** "hoy 14:32", "ayer 18:10", "27-09-2026 18:10". */
export function formatRelativeDateTime(ms: number, now: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const date = zonedDate(ms, timeZone);
  const today = zonedDate(now, timeZone);
  const time = formatTime(ms, timeZone);
  if (date === today) return `hoy ${time}`;
  if (date === addDays(today, -1)) return `ayer ${time}`;
  return `${formatShortDate(date)} ${time}`;
}
