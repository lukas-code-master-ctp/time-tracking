import { describe, expect, it } from 'vitest';
import {
  ABSENCE_TYPES,
  ABSENCE_TYPE_LABELS,
  absenceIntervalsForDay,
  absenceOverlapsRange,
  absenceStatus,
  complianceForDay,
  complianceForRange,
  describeAbsenceWhen,
  mergeIntervals,
  validateAbsence,
  zonedDateTimeToMs,
  zonedDayBounds,
  type Absence,
  type DaySchedule,
  type Session,
  type WeekSchedule,
} from '../src/index.js';

const at = (date: string, time: string): number => zonedDateTimeToMs(date, time);

const LJ: DaySchedule = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };
const V: DaySchedule = { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null };
const WEEK: WeekSchedule = { mon: LJ, tue: LJ, wed: LJ, thu: LJ, fri: V, sat: null, sun: null };

// 2026-09-28 is a Monday.
const MON = '2026-09-28';
const TUE = '2026-09-29';
const LATER = Date.UTC(2026, 11, 1);

function closed(date: string, from: string, to: string): Session {
  const endedAt = at(date, to);
  return { uid: 'u', startedAt: at(date, from), endedAt, endReason: 'manual', lastHeartbeatAt: endedAt };
}

function absence(overrides: Partial<Absence> = {}): Absence {
  return {
    uid: 'u',
    type: 'vacation',
    startDate: MON,
    endDate: MON,
    startTime: null,
    endTime: null,
    note: '',
    createdAt: 1,
    createdBy: 'admin',
    updatedAt: 1,
    updatedBy: 'admin',
    ...overrides,
  };
}

const errand = (from: string, to: string, date = MON): Absence =>
  absence({ type: 'errand', startDate: date, endDate: date, startTime: from, endTime: to });

describe('absence types', () => {
  it('has a label for every type', () => {
    expect(ABSENCE_TYPES.map((t) => ABSENCE_TYPE_LABELS[t])).toEqual(['Vacaciones', 'Licencia médica', 'Trámite', 'Permiso', 'Otro']);
  });
});

describe('validateAbsence', () => {
  const paths = (a: Absence): string[] => validateAbsence(a).map((i) => i.path);

  it('accepts whole days and a span of hours', () => {
    expect(validateAbsence(absence({ endDate: '2026-10-09' }))).toEqual([]);
    expect(validateAbsence(errand('09:00', '11:30'))).toEqual([]);
  });

  it('rejects bad dates, reversed ranges and absences longer than a year', () => {
    expect(paths(absence({ startDate: '2026-02-30' }))).toEqual(['startDate']);
    expect(paths(absence({ endDate: '2026-09-27' }))).toEqual(['endDate']);
    expect(paths(absence({ endDate: '2027-09-29' }))).toEqual(['endDate']);
    expect(paths(absence({ endDate: '2027-09-28' }))).toEqual([]);
  });

  it('rejects hours that are reversed, malformed, or over several days', () => {
    expect(paths(errand('11:00', '11:00'))).toEqual(['endTime']);
    expect(paths(errand('9:00', '11:00'))).toEqual(['startTime']);
    expect(paths({ ...errand('09:00', '11:00'), endDate: TUE })).toEqual(['endDate']);
    expect(paths({ ...errand('09:00', '11:00'), endTime: null })).toEqual(['endTime']);
  });

  it('requires a comment for "Otro" and limits its length', () => {
    expect(paths(absence({ type: 'other' }))).toEqual(['note']);
    expect(paths(absence({ type: 'other', note: 'Mudanza' }))).toEqual([]);
    expect(paths(absence({ note: 'x'.repeat(501) }))).toEqual(['note']);
    expect(paths(absence({ type: 'nap' as never }))).toEqual(['type']);
  });
});

describe('absence intervals', () => {
  it('whole days cover the calendar day; hours cover their span', () => {
    expect(absenceIntervalsForDay(MON, [absence()])).toEqual([zonedDayBounds(MON)]);
    expect(absenceIntervalsForDay(TUE, [absence()])).toEqual([]);
    expect(absenceIntervalsForDay(MON, [errand('09:00', '10:00'), errand('09:30', '11:00')])).toEqual([
      { start: at(MON, '09:00'), end: at(MON, '11:00') },
    ]);
  });

  it('only approved absences justify time (no status = approved)', () => {
    expect(absenceIntervalsForDay(MON, [absence({ status: 'pending' })])).toEqual([]);
    expect(absenceIntervalsForDay(MON, [absence({ status: 'rejected' })])).toEqual([]);
    expect(absenceIntervalsForDay(MON, [absence({ status: 'approved' })])).toEqual([zonedDayBounds(MON)]);
    expect(absenceStatus({})).toBe('approved');
    expect(absenceStatus({ status: 'pending' })).toBe('pending');
    expect(complianceForDay(MON, [], WEEK, [], 5, LATER, undefined, [absence({ status: 'pending' })]).absent).toBe(true);
  });

  it('merges touching intervals', () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 5 }, { start: 9, end: 9 }])).toEqual([{ start: 1, end: 8 }]);
  });

  it('overlaps a range of dates', () => {
    const a = absence({ startDate: MON, endDate: '2026-10-02' });
    expect(absenceOverlapsRange(a, '2026-10-02', '2026-10-31')).toBe(true);
    expect(absenceOverlapsRange(a, '2026-10-03', '2026-10-31')).toBe(false);
    expect(absenceOverlapsRange(a, '2026-09-01', MON)).toBe(true);
  });

  it('describes when', () => {
    expect(describeAbsenceWhen(absence())).toBe('28-09-2026, día completo');
    expect(describeAbsenceWhen(absence({ endDate: '2026-10-02' }))).toBe('28-09-2026 al 02-10-2026');
    expect(describeAbsenceWhen(errand('09:00', '11:30'))).toBe('28-09-2026, 09:00–11:30');
  });
});

describe('compliance with justified absences', () => {
  const day = (sessions: Session[], absences: Absence[], date = MON, now = LATER) =>
    complianceForDay(date, sessions, WEEK, [], 5, now, undefined, absences);

  it('a whole day justified is not an absence nor offline time', () => {
    const c = day([], [absence()]);
    expect(c).toMatchObject({ absent: false, justified: true, justifiedSeconds: 8.5 * 3600, offlineSeconds: 0, expectedSeconds: 8.5 * 3600 });
    expect(day([], []).absent).toBe(true);
  });

  it('an errand at the start moves the entry used for lateness', () => {
    const c = day([closed(MON, '11:00', '18:30')], [errand('09:00', '11:00')]);
    expect(c).toMatchObject({ late: false, justifiedSeconds: 2 * 3600, offlineSeconds: 0, justified: false });
    const late = day([closed(MON, '11:20', '18:30')], [errand('09:00', '11:00')]);
    expect(late.lateSeconds).toBe(20 * 60);
    expect(late.offlineSeconds).toBe(20 * 60);
  });

  it('a morning justified until lunch skips the lunch too', () => {
    expect(day([closed(MON, '14:00', '18:30')], [errand('09:00', '13:00')]).late).toBe(false);
  });

  it('an errand at the end moves the exit used for the early leave', () => {
    expect(day([closed(MON, '09:00', '16:00')], [errand('16:00', '18:30')]).earlyLeave).toBe(false);
    expect(day([closed(MON, '09:00', '15:00')], [errand('16:00', '18:30')]).earlyLeaveSeconds).toBe(3600);
  });

  it('an errand in the middle is not offline time', () => {
    const c = day([closed(MON, '09:00', '10:00'), closed(MON, '12:00', '18:30')], [errand('10:00', '12:00')]);
    expect(c.offlineSeconds).toBe(0);
    expect(c.inScheduleSeconds).toBe(6.5 * 3600);
  });

  it('a partial justification on a day without any connection is still an absence', () => {
    expect(day([], [errand('09:00', '11:00')])).toMatchObject({ absent: true, justified: false, justifiedSeconds: 2 * 3600 });
  });

  it('does nothing on a day off', () => {
    expect(day([], [absence({ startDate: '2026-10-03', endDate: '2026-10-03' })], '2026-10-03')).toMatchObject({
      justified: false,
      justifiedSeconds: 0,
    });
  });

  it('only counts the justified time until now for the offline time', () => {
    const c = day([], [errand('09:00', '11:00')], MON, at(MON, '12:00'));
    expect(c.offlineSeconds).toBe(3600);
  });

  it('adds up the justified days and time over a range', () => {
    const vacation = absence({ startDate: MON, endDate: '2026-10-04' });
    const r = complianceForRange(MON, '2026-10-04', [], WEEK, [], 5, LATER, undefined, [vacation]);
    expect(r.totals).toMatchObject({ absentDays: 0, justifiedDays: 5, justifiedSeconds: (4 * 8.5 + 5) * 3600, offlineSeconds: 0 });
    expect(r.totals.justifiedSeconds).toBe(r.totals.expectedSeconds);
  });
});
