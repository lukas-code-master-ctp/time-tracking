/**
 * Justified absences (spec 2026-10-22-ausencias-justificadas.md): vacations,
 * medical leave, errands… recorded by an admin so the time they cover does
 * not count as an absence, a late arrival, an early leave or offline time.
 * Pure.
 *
 * An absence is either whole days (`startDate..endDate`, both inclusive, the
 * times null) or a span of hours inside one day (`startDate == endDate`,
 * `startTime < endTime`). Dates and times are wall-clock in America/Santiago,
 * like the schedule. How they change the compliance is in `schedule.ts`
 * (`absenceIntervalsForDay`, `complianceForDay`).
 */

import { isValidDateKey, isValidTime, type ScheduleIssue } from './schedule.js';
import type { Absence, AbsenceType } from './types.js';

/** In the order of the portal's select. */
export const ABSENCE_TYPES: readonly AbsenceType[] = Object.freeze(['vacation', 'medical', 'errand', 'permission', 'other']);

export const ABSENCE_TYPE_LABELS: Readonly<Record<AbsenceType, string>> = Object.freeze({
  vacation: 'Vacaciones',
  medical: 'Licencia médica',
  errand: 'Trámite',
  permission: 'Permiso',
  other: 'Otro',
});

/** Longest comment. Same limit as `firestore.rules`. */
export const MAX_ABSENCE_NOTE = 500;
/** Longest absence (days, both ends included). Same limit as `firestore.rules`. */
export const MAX_ABSENCE_DAYS = 366;

export function isAbsenceType(value: unknown): value is AbsenceType {
  return typeof value === 'string' && (ABSENCE_TYPES as readonly string[]).includes(value);
}

/** Days between two valid dates (`b - a`), calendar arithmetic. */
function daysBetween(a: string, b: string): number {
  const ms = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** True for an absence of whole days (no times). */
export function isFullDayAbsence(a: Pick<Absence, 'startTime' | 'endTime'>): boolean {
  return a.startTime === null && a.endTime === null;
}

/** Problems of the editable fields ([] = valid). Messages in Spanish, for the portal. */
export function validateAbsence(
  a: Pick<Absence, 'type' | 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'note'>,
): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  if (!isAbsenceType(a.type)) issues.push({ path: 'type', message: 'Elige el tipo de ausencia.' });
  const startOk = isValidDateKey(a.startDate);
  const endOk = isValidDateKey(a.endDate);
  if (!startOk) issues.push({ path: 'startDate', message: 'La fecha de inicio no es válida.' });
  if (!endOk) issues.push({ path: 'endDate', message: 'La fecha de término no es válida.' });
  if (startOk && endOk) {
    if (a.endDate < a.startDate) {
      issues.push({ path: 'endDate', message: 'La fecha de término no puede ser anterior a la de inicio.' });
    } else if (daysBetween(a.startDate, a.endDate) + 1 > MAX_ABSENCE_DAYS) {
      issues.push({ path: 'endDate', message: `Una ausencia puede durar hasta ${MAX_ABSENCE_DAYS} días.` });
    }
  }
  if (!isFullDayAbsence(a)) {
    if (!isValidTime(a.startTime)) issues.push({ path: 'startTime', message: 'La hora de inicio no es válida.' });
    if (!isValidTime(a.endTime)) issues.push({ path: 'endTime', message: 'La hora de término no es válida.' });
    if (isValidTime(a.startTime) && isValidTime(a.endTime) && a.startTime >= a.endTime) {
      issues.push({ path: 'endTime', message: 'La hora de término debe ser posterior a la de inicio.' });
    }
    if (startOk && endOk && a.startDate !== a.endDate) {
      issues.push({ path: 'endDate', message: 'Una ausencia por horas es de un solo día.' });
    }
  }
  if (typeof a.note !== 'string' || a.note.length > MAX_ABSENCE_NOTE) {
    issues.push({ path: 'note', message: `El comentario puede tener hasta ${MAX_ABSENCE_NOTE} caracteres.` });
  } else if (a.type === 'other' && a.note.trim() === '') {
    issues.push({ path: 'note', message: 'Para "Otro", escribe un comentario con el motivo.' });
  }
  return issues;
}

/** True when the absence touches `date`. */
export function absenceCoversDate(a: Pick<Absence, 'startDate' | 'endDate'>, date: string): boolean {
  return a.startDate <= date && date <= a.endDate;
}

/** True when the absence touches any day of `fromDate..toDate` (inclusive). */
export function absenceOverlapsRange(a: Pick<Absence, 'startDate' | 'endDate'>, fromDate: string, toDate: string): boolean {
  return a.startDate <= toDate && a.endDate >= fromDate;
}

/**
 * "Vacaciones · 03-11 al 14-11", "Trámite · 09:00–11:30": short description
 * of when (dates as `DD-MM`, like the portal's short dates).
 */
export function describeAbsenceWhen(a: Pick<Absence, 'startDate' | 'endDate' | 'startTime' | 'endTime'>): string {
  const short = (d: string): string => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
  if (!isFullDayAbsence(a)) return `${short(a.startDate)}, ${a.startTime ?? ''}–${a.endTime ?? ''}`;
  if (a.startDate === a.endDate) return `${short(a.startDate)}, día completo`;
  return `${short(a.startDate)} al ${short(a.endDate)}`;
}
