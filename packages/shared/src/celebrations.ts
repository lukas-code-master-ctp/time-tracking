/**
 * Team birthdays and work anniversaries (spec 2026-11-05-cumpleanos-aniversarios).
 * An admin records each person's birthday (`MM-DD`, no year) and hire date
 * (`YYYY-MM-DD`) in the portal; the extension popup shows today's and the
 * next days' celebrations of the active people. Pure.
 */

import { isValidDateKey, type ScheduleIssue } from './schedule.js';
import type { Celebration } from './types.js';

export const BIRTHDAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/** Days in each month of a leap year (a birthday may be on Feb 29). */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `MM-DD` of a real calendar day (Feb 29 allowed). */
export function isValidBirthday(value: unknown): value is string {
  if (typeof value !== 'string' || !BIRTHDAY_RE.test(value)) return false;
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3, 5));
  return day <= MONTH_DAYS[month - 1]!;
}

/** Problems of the editable fields ([] = valid). Messages in Spanish, for the portal. */
export function validateCelebration(
  c: Pick<Celebration, 'birthday' | 'hireDate'>,
  today: string,
): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  if (c.birthday !== null && !isValidBirthday(c.birthday)) {
    issues.push({ path: 'birthday', message: 'El cumpleaños no es una fecha válida.' });
  }
  if (c.hireDate !== null) {
    if (!isValidDateKey(c.hireDate)) issues.push({ path: 'hireDate', message: 'La fecha de ingreso no es válida.' });
    else if (c.hireDate > today) issues.push({ path: 'hireDate', message: 'La fecha de ingreso no puede ser futura.' });
    else if (c.hireDate < '1950-01-01') issues.push({ path: 'hireDate', message: 'La fecha de ingreso no es válida.' });
  }
  return issues;
}

/** Reads a stored document; null when it is not valid. */
export function readCelebration(raw: unknown): Celebration | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.displayName !== 'string') return null;
  const birthday = d.birthday === null || d.birthday === undefined ? null : d.birthday;
  const hireDate = d.hireDate === null || d.hireDate === undefined ? null : d.hireDate;
  if (birthday !== null && !isValidBirthday(birthday)) return null;
  if (hireDate !== null && !isValidDateKey(hireDate)) return null;
  return {
    displayName: d.displayName,
    birthday,
    hireDate,
    active: d.active !== false,
    managerUid: typeof d.managerUid === 'string' && d.managerUid ? d.managerUid : null,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : '',
  };
}

export type CelebrationKind = 'birthday' | 'anniversary';

export interface UpcomingCelebration {
  uid: string;
  name: string;
  kind: CelebrationKind;
  /** The day it is celebrated, `YYYY-MM-DD`. */
  date: string;
  /** 0 = today. */
  daysAway: number;
  /** Anniversary: years in the company that day (1 or more). Birthday: null. */
  years: number | null;
  /** uid of the person's boss, or null. */
  managerUid: string | null;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` of `MM-DD` in `year`; Feb 29 is celebrated on Feb 28 in other years. */
function inYear(monthDay: string, year: number): string {
  const md = monthDay === '02-29' && !isLeap(year) ? '02-28' : monthDay;
  return `${year}-${md}`;
}

function addDays(date: string, days: number): string {
  const t = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function daysBetween(a: string, b: string): number {
  const ms = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** Next day (today or later) a `MM-DD` is celebrated. */
function nextOccurrence(monthDay: string, today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = inYear(monthDay, year);
  return thisYear >= today ? thisYear : inYear(monthDay, year + 1);
}

/**
 * Birthdays and work anniversaries of the active people from `today`
 * (`YYYY-MM-DD`, America/Santiago) to `today + withinDays` (inclusive),
 * soonest first, then by name. An anniversary needs at least one full year.
 */
export function upcomingCelebrations(
  docs: readonly (Celebration & { id: string })[],
  today: string,
  withinDays: number,
): UpcomingCelebration[] {
  const out: UpcomingCelebration[] = [];
  const last = addDays(today, withinDays);
  for (const c of docs) {
    if (!c.active) continue;
    const name = c.displayName.trim() || 'Alguien del equipo';
    if (c.birthday && isValidBirthday(c.birthday)) {
      const date = nextOccurrence(c.birthday, today);
      if (date <= last) {
        out.push({ uid: c.id, name, kind: 'birthday', date, daysAway: daysBetween(today, date), years: null, managerUid: c.managerUid ?? null });
      }
    }
    if (c.hireDate && isValidDateKey(c.hireDate)) {
      const date = nextOccurrence(c.hireDate.slice(5), today);
      const years = Number(date.slice(0, 4)) - Number(c.hireDate.slice(0, 4));
      if (date <= last && years >= 1) {
        out.push({ uid: c.id, name, kind: 'anniversary', date, daysAway: daysBetween(today, date), years, managerUid: c.managerUid ?? null });
      }
    }
  }
  return out.sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name, 'es') || a.kind.localeCompare(b.kind));
}

/** "1 año", "3 años". */
export function yearsLabel(years: number): string {
  return `${years} ${years === 1 ? 'año' : 'años'}`;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "14 de marzo" from `MM-DD` or `YYYY-MM-DD`. */
export function dayMonthLabel(date: string): string {
  const md = date.length === 10 ? date.slice(5) : date;
  return `${Number(md.slice(3, 5))} de ${MONTHS[Number(md.slice(0, 2)) - 1] ?? ''}`;
}
