/**
 * Justified absences in the portal (spec 2026-10-22-ausencias-justificadas):
 * the form of "Agregar ausencia", the document written (exactly as
 * `firestore.rules` accepts it) and the labels. Pure: the caller passes the
 * admin uid and the clock.
 */
import {
  ABSENCE_TYPE_LABELS,
  describeAbsenceWhen,
  isFullDayAbsence,
  validateAbsence,
  type Absence,
  type AbsenceType,
  type ScheduleIssue,
  type WithId,
} from '@timetracking/shared';

export interface AbsenceForm {
  type: AbsenceType;
  /** Whole days, or a span of hours inside one day. */
  mode: 'days' | 'hours';
  /** `YYYY-MM-DD` as typed ('' when cleared). In `hours` mode it is the day. */
  startDate: string;
  /** Only used in `days` mode. */
  endDate: string;
  /** `HH:MM`, only used in `hours` mode. */
  startTime: string;
  endTime: string;
  note: string;
}

/** Form of a new absence on `date` (the day being looked at). */
export function emptyAbsenceForm(date: string): AbsenceForm {
  return { type: 'vacation', mode: 'days', startDate: date, endDate: date, startTime: '09:00', endTime: '11:00', note: '' };
}

export function absenceToForm(a: Absence): AbsenceForm {
  const hours = !isFullDayAbsence(a);
  return {
    type: a.type,
    mode: hours ? 'hours' : 'days',
    startDate: a.startDate,
    endDate: a.endDate,
    startTime: a.startTime ?? '09:00',
    endTime: a.endTime ?? '11:00',
    note: a.note,
  };
}

/** The editable fields the form stands for. */
function formFields(form: AbsenceForm): Pick<Absence, 'type' | 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'note'> {
  const hours = form.mode === 'hours';
  return {
    type: form.type,
    startDate: form.startDate,
    endDate: hours ? form.startDate : form.endDate,
    startTime: hours ? form.startTime : null,
    endTime: hours ? form.endTime : null,
    note: form.note.trim(),
  };
}

/** Every problem of the form ([] = it can be saved). */
export function validateAbsenceForm(form: AbsenceForm): ScheduleIssue[] {
  return validateAbsence(formFields(form));
}

/**
 * `absences/{id}` with the 11 fields the rules require. A change keeps the
 * person and the creation of `existing`. Throws when invalid.
 */
export function buildAbsence(form: AbsenceForm, uid: string, adminUid: string, now: number, existing?: Absence | null): Absence {
  const issues = validateAbsenceForm(form);
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(' '));
  const at = Math.floor(now);
  return {
    uid: existing?.uid ?? uid,
    ...formFields(form),
    createdAt: existing?.createdAt ?? at,
    createdBy: existing?.createdBy ?? adminUid,
    updatedAt: at,
    updatedBy: adminUid,
  };
}

/** "Vacaciones · 03-11-2026 al 14-11-2026". */
export function absenceTitle(a: Absence): string {
  return `${ABSENCE_TYPE_LABELS[a.type] ?? 'Ausencia'} · ${describeAbsenceWhen(a)}`;
}

/** Newest first (by start date, then start time). */
export function sortAbsences<T extends Absence>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => b.startDate.localeCompare(a.startDate) || (b.startTime ?? '').localeCompare(a.startTime ?? '') || a.type.localeCompare(b.type),
  );
}

/** Absences of `uid`, by uid, for {@link teamCompliance}. */
export function absencesByUid(list: readonly WithId<Absence>[]): Map<string, WithId<Absence>[]> {
  const out = new Map<string, WithId<Absence>[]>();
  for (const a of list) {
    const l = out.get(a.uid);
    if (l) l.push(a);
    else out.set(a.uid, [a]);
  }
  return out;
}
