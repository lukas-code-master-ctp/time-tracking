import { describe, expect, it } from 'vitest';
import {
  CHILE_HOLIDAYS,
  CHILE_HOLIDAY_DATES,
  MAX_HOLIDAYS,
  addDaysToDateKey,
  chileHolidayName,
  classifyInstant,
  complianceForDay,
  complianceForRange,
  dateKey,
  effectiveWeek,
  emptyWeek,
  isValidDateKey,
  isValidTime,
  normalizeHolidays,
  planForDay,
  readPersonSchedule,
  readScheduleConfig,
  startOfZonedDay,
  timeToMinutes,
  validateDaySchedule,
  validateHolidays,
  validatePersonSchedule,
  validateScheduleConfig,
  weekdayOfDateKey,
  windowsForDay,
  zonedDateTimeToMs,
  zonedDayBounds,
  type DaySchedule,
  type ScheduleConfig,
  type Session,
  type WeekSchedule,
} from '../src/index.js';

const H = 3_600_000;
const at = (date: string, time: string): number => zonedDateTimeToMs(date, time);
const iso = (s: string): number => Date.parse(s);

const LJ: DaySchedule = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };
const V: DaySchedule = { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null };
/** Spec acceptance schedule: Mon–Thu 9:00–18:30 (lunch 13–14), Fri 9:00–14:00. */
const WEEK: WeekSchedule = { mon: LJ, tue: LJ, wed: LJ, thu: LJ, fri: V, sat: null, sun: null };

// 2026-09-28 is a Monday.
const MON = '2026-09-28';
const FRI = '2026-10-02';
const SAT = '2026-10-03';
const SUN = '2026-09-27';

function closed(date: string, from: string, to: string, toDate = date): Session {
  const startedAt = at(date, from);
  const endedAt = at(toDate, to);
  return { uid: 'u', startedAt, endedAt, endReason: 'manual', lastHeartbeatAt: endedAt };
}

function open(startedAt: number, lastHeartbeatAt: number): Session {
  return { uid: 'u', startedAt, endedAt: null, endReason: null, lastHeartbeatAt };
}

function config(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    week: WEEK,
    holidays: ['2026-12-25'],
    toleranceMinutes: 5,
    remindersEnabled: true,
    updatedAt: 1,
    updatedBy: 'admin',
    ...overrides,
  };
}

const LATER = at('2026-12-31', '12:00');

describe('times and dates', () => {
  it('validates HH:MM (24 h)', () => {
    for (const t of ['00:00', '09:05', '13:59', '23:59']) expect(isValidTime(t)).toBe(true);
    for (const t of ['24:00', '9:00', '09:60', '0900', '09:00:00', '', ' 09:00', 900, null]) expect(isValidTime(t)).toBe(false);
    expect(timeToMinutes('18:30')).toBe(1110);
    expect(() => timeToMinutes('25:00')).toThrow('Hora inválida');
  });

  it('dates, weekdays and calendar arithmetic', () => {
    expect(isValidDateKey('2026-02-29')).toBe(false);
    expect(isValidDateKey('2028-02-29')).toBe(true);
    expect(isValidDateKey('2026-9-1')).toBe(false);
    expect(weekdayOfDateKey(MON)).toBe('mon');
    expect(weekdayOfDateKey(SUN)).toBe('sun');
    expect(weekdayOfDateKey('2026-09-30')).toBe('wed');
    expect(addDaysToDateKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDaysToDateKey('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('wall-clock time to ms in America/Santiago (summer -3, winter -4)', () => {
    expect(at('2026-09-30', '09:00')).toBe(iso('2026-09-30T12:00:00Z'));
    expect(at('2026-07-01', '09:00')).toBe(iso('2026-07-01T13:00:00Z'));
  });

  it('September change (00:00 → 01:00): a skipped time is the instant of the jump', () => {
    const jump = iso('2026-09-06T04:00:00Z'); // 01:00 -03
    expect(at('2026-09-06', '00:00')).toBe(jump);
    expect(at('2026-09-06', '00:30')).toBe(jump);
    expect(at('2026-09-06', '00:59')).toBe(jump);
    expect(at('2026-09-06', '01:00')).toBe(jump);
    expect(at('2026-09-06', '01:30')).toBe(iso('2026-09-06T04:30:00Z'));
    expect(at('2026-09-05', '23:59')).toBe(iso('2026-09-06T03:59:00Z'));
    const day = zonedDayBounds('2026-09-06');
    expect(day.end - day.start).toBe(23 * H);
  });

  it('April change (24:00 → 23:00): a repeated time is its first occurrence', () => {
    expect(at('2026-04-04', '23:30')).toBe(iso('2026-04-05T02:30:00Z')); // -03, before going back
    expect(at('2026-04-04', '22:59')).toBe(iso('2026-04-05T01:59:00Z'));
    expect(at('2026-04-05', '00:00')).toBe(iso('2026-04-05T04:00:00Z')); // -04
    const day = zonedDayBounds('2026-04-04');
    expect(day.end - day.start).toBe(25 * H);
  });

  it('startOfZonedDay is the first instant of the date', () => {
    for (const d of ['2026-09-06', '2026-04-04', '2026-04-05', '2027-09-05', '2027-04-03', '2026-09-30']) {
      const s = startOfZonedDay(d);
      expect(dateKey(s)).toBe(d);
      expect(dateKey(s - 1)).toBe(addDaysToDateKey(d, -1));
    }
  });
});

describe('validation', () => {
  it('a valid config and exception have no issues', () => {
    expect(validateScheduleConfig(config())).toEqual([]);
    expect(validateScheduleConfig(config({ week: emptyWeek(), holidays: [], toleranceMinutes: 0 }))).toEqual([]);
    expect(validatePersonSchedule({ week: WEEK, updatedAt: 1, updatedBy: 'admin' })).toEqual([]);
  });

  it('day: format, order, lunch pair and lunch inside the day (Spanish messages)', () => {
    const v = (d: unknown) => validateDaySchedule(d, 'mon').map((i) => i.message);
    expect(v(null)).toEqual([]);
    expect(v({ ...LJ, lunchStart: '09:00', lunchEnd: '18:30' })).toEqual([]); // borders allowed
    expect(v({ ...LJ, start: '9:00' })).toEqual(['Lunes: la hora de entrada debe tener formato HH:MM (24 h).']);
    expect(v({ ...LJ, end: '24:00' })).toEqual(['Lunes: la hora de salida debe tener formato HH:MM (24 h).']);
    expect(v({ ...V, start: '14:00', end: '09:00' })[0]).toMatch(/salida debe ser posterior a la entrada/);
    expect(v({ ...V, start: '09:00', end: '09:00' })[0]).toMatch(/posterior/);
    expect(v({ ...LJ, lunchEnd: null })).toEqual(['Lunes: la colación necesita inicio y término, o ninguno de los dos.']);
    expect(v({ ...LJ, lunchStart: '14:00', lunchEnd: '13:00' })[0]).toMatch(/término de la colación debe ser posterior/);
    expect(v({ ...LJ, lunchStart: '08:30', lunchEnd: '09:30' })).toEqual(['Lunes: la colación debe quedar dentro del horario (09:00–18:30).']);
    expect(v({ ...LJ, lunchStart: '18:00', lunchEnd: '19:00' })[0]).toMatch(/dentro del horario/);
    expect(v({ ...LJ, lunchStart: '1pm', lunchEnd: '14:00' })[0]).toMatch(/inicio de la colación/);
    expect(v({ ...LJ, extra: 1 })[0]).toMatch(/campos no permitidos/);
    expect(v({ start: '09:00', end: '18:00' })).toHaveLength(2); // lunch fields missing
    expect(v('09:00-18:00')).toEqual(['Lunes: el horario no es válido.']);
  });

  it('week: exactly the seven days', () => {
    const { sun: _sun, ...six } = WEEK;
    expect(validateScheduleConfig(config({ week: six as WeekSchedule }))[0]!.message).toMatch(/Domingo: falta el horario/);
    expect(validateScheduleConfig(config({ week: { ...WEEK, lun: null } as unknown as WeekSchedule }))[0]!.message).toMatch(
      /días desconocidos \(lun\)/,
    );
    const issues = validateScheduleConfig(config({ week: { ...WEEK, fri: { ...V, end: '08:00' } } }));
    expect(issues[0]).toMatchObject({ path: 'week.fri.end' });
    expect(issues[0]!.message.startsWith('Viernes:')).toBe(true);
  });

  it('holidays: dates, unique, at most 60', () => {
    expect(validateHolidays([])).toEqual([]);
    expect(validateHolidays(['2026-02-30'])[0]!.message).toMatch(/AAAA-MM-DD/);
    expect(validateHolidays(['2026-12-25', '2026-12-25'])[0]!.message).toMatch(/repetido/);
    const many = Array.from({ length: MAX_HOLIDAYS + 1 }, (_, i) => addDaysToDateKey('2026-01-01', i));
    expect(validateHolidays(many.slice(0, MAX_HOLIDAYS))).toEqual([]);
    expect(validateHolidays(many)[0]!.message).toMatch(/hasta 60 feriados/);
    expect(validateHolidays('2026-12-25')[0]!.message).toMatch(/no es válida/);
    expect(normalizeHolidays(['2026-12-25', 'x', '2026-01-01', '2026-12-25'])).toEqual(['2026-01-01', '2026-12-25']);
  });

  it('tolerance, reminders, metadata and extra fields', () => {
    const msg = (c: unknown) => validateScheduleConfig(c).map((i) => i.path);
    expect(msg(config({ toleranceMinutes: 61 }))).toEqual(['toleranceMinutes']);
    expect(msg(config({ toleranceMinutes: -1 }))).toEqual(['toleranceMinutes']);
    expect(msg(config({ toleranceMinutes: 2.5 }))).toEqual(['toleranceMinutes']);
    expect(msg({ ...config(), remindersEnabled: 'yes' })).toEqual(['remindersEnabled']);
    expect(msg({ ...config(), updatedBy: '' })).toEqual(['updatedBy']);
    expect(msg({ ...config(), updatedAt: 1.5 })).toEqual(['updatedAt']);
    expect(msg({ ...config(), extra: true })).toEqual(['']);
    expect(msg(null)).toEqual(['']);
    expect(validatePersonSchedule({ week: WEEK, holidays: [], updatedAt: 1, updatedBy: 'a' })[0]!.message).toMatch(/holidays/);
  });

  it('readScheduleConfig / readPersonSchedule return a clean copy or null', () => {
    const c = config();
    const read = readScheduleConfig(c)!;
    expect(read).toEqual(c);
    expect(read.week).not.toBe(c.week);
    expect(readScheduleConfig({ ...c, toleranceMinutes: 90 })).toBeNull();
    expect(readScheduleConfig(undefined)).toBeNull();
    expect(readPersonSchedule({ week: WEEK, updatedAt: 1, updatedBy: 'a' })).toEqual({ week: WEEK, updatedAt: 1, updatedBy: 'a' });
    expect(readPersonSchedule({ week: { ...WEEK, mon: { ...LJ, start: 'x' } }, updatedAt: 1, updatedBy: 'a' })).toBeNull();
  });
});

describe('Chile holidays 2026–2027', () => {
  it('valid, sorted, unique and within the 60 allowed', () => {
    expect(CHILE_HOLIDAYS).toHaveLength(33);
    expect(CHILE_HOLIDAY_DATES.filter((d) => d.startsWith('2026'))).toHaveLength(16);
    expect(CHILE_HOLIDAY_DATES.filter((d) => d.startsWith('2027'))).toHaveLength(17);
    expect([...CHILE_HOLIDAY_DATES].sort()).toEqual(CHILE_HOLIDAY_DATES);
    expect(validateHolidays([...CHILE_HOLIDAY_DATES])).toEqual([]);
  });

  it('movable dates follow the laws', () => {
    // Easter: 2026-04-05 and 2027-03-28.
    expect(chileHolidayName('2026-04-03')).toBe('Viernes Santo');
    expect(chileHolidayName('2027-03-26')).toBe('Viernes Santo');
    // Ley 19.668: Tuesday → previous Monday.
    expect(weekdayOfDateKey('2027-06-28')).toBe('mon');
    expect(chileHolidayName('2027-06-29')).toBeNull();
    expect(weekdayOfDateKey('2027-10-11')).toBe('mon');
    // Ley 20.983: September 18–19 on Saturday–Sunday → Friday 17.
    expect(weekdayOfDateKey('2027-09-17')).toBe('fri');
    expect(chileHolidayName('2027-09-17')).toMatch(/Fiestas Patrias/);
    expect(chileHolidayName('2026-09-17')).toBeNull();
  });
});

describe('schedule of a day', () => {
  it('effectiveWeek: the exception replaces the general week', () => {
    const other: WeekSchedule = { ...emptyWeek(), sat: V };
    expect(effectiveWeek(config(), null)).toBe(WEEK);
    expect(effectiveWeek(config(), { week: other })).toBe(other);
    expect(effectiveWeek(null, { week: other })).toBe(other);
    expect(effectiveWeek(null, undefined)).toBeNull();
  });

  it('windowsForDay: working windows without the lunch', () => {
    expect(windowsForDay(MON, WEEK, [])).toEqual([
      { start: at(MON, '09:00'), end: at(MON, '13:00') },
      { start: at(MON, '14:00'), end: at(MON, '18:30') },
    ]);
    expect(windowsForDay(FRI, WEEK, [])).toEqual([{ start: at(FRI, '09:00'), end: at(FRI, '14:00') }]);
    expect(windowsForDay(SAT, WEEK, [])).toEqual([]);
    expect(windowsForDay(MON, WEEK, [MON])).toEqual([]);
    expect(windowsForDay(MON, null, [])).toEqual([]);
    // Lunch at the start of the day: only the afternoon window.
    const early: WeekSchedule = { ...WEEK, mon: { ...LJ, lunchStart: '09:00', lunchEnd: '10:00' } };
    expect(windowsForDay(MON, early, [])).toEqual([{ start: at(MON, '10:00'), end: at(MON, '18:30') }]);
    const plan = planForDay(MON, WEEK, [MON]);
    expect(plan).toMatchObject({ holiday: true, schedule: null, span: null, lunch: null });
  });

  it('classifyInstant', () => {
    const c = (date: string, time: string, holidays: string[] = []) => classifyInstant(at(date, time), WEEK, holidays);
    expect(c(MON, '08:59')).toBe('off');
    expect(c(MON, '09:00')).toBe('work');
    expect(c(MON, '12:59')).toBe('work');
    expect(c(MON, '13:00')).toBe('lunch');
    expect(c(MON, '13:30')).toBe('lunch');
    expect(c(MON, '14:00')).toBe('work');
    expect(c(MON, '18:29')).toBe('work');
    expect(c(MON, '18:30')).toBe('off');
    expect(c(MON, '19:00')).toBe('off');
    expect(c(FRI, '13:30')).toBe('work');
    expect(c(FRI, '15:00')).toBe('off');
    expect(c(SAT, '10:00')).toBe('off');
    expect(c(MON, '10:00', [MON])).toBe('off');
    expect(classifyInstant(at(MON, '10:00'), null, [])).toBe('off');
  });
});

describe('complianceForDay', () => {
  const day = (sessions: Session[], now = LATER, date = MON, tol = 5, holidays: string[] = []) =>
    complianceForDay(date, sessions, WEEK, holidays, tol, now);

  it('work day 8:00–19:00 (spec): 8.5 h in schedule, 1 h lunch, 1.5 h outside', () => {
    const c = day([closed(MON, '08:00', '19:00')]);
    expect(c).toMatchObject({
      workday: true,
      holiday: false,
      state: 'finished',
      expectedSeconds: 8.5 * 3600,
      expectedSoFarSeconds: 8.5 * 3600,
      connectedSeconds: 11 * 3600,
      inScheduleSeconds: 8.5 * 3600,
      lunchSeconds: 3600,
      outsideScheduleSeconds: 1.5 * 3600,
      offlineSeconds: 0,
      arrivalAt: at(MON, '09:00'),
      departureAt: at(MON, '18:30'),
      late: false,
      lateSeconds: 0,
      earlyLeave: false,
      absent: false,
    });
  });

  it('late arrival only beyond the tolerance, and then the whole delay', () => {
    expect(day([closed(MON, '09:05', '18:30')]).late).toBe(false);
    const c = day([closed(MON, '09:06', '18:30')]);
    expect(c).toMatchObject({ late: true, lateSeconds: 6 * 60, offlineSeconds: 6 * 60 });
    expect(day([closed(MON, '09:06', '18:30')], LATER, MON, 0).lateSeconds).toBe(6 * 60);
    expect(day([closed(MON, '09:30', '18:30')], LATER, MON, 30).late).toBe(false);
  });

  it('a session that ended before the entry is not the arrival', () => {
    const c = day([closed(MON, '07:00', '08:00'), closed(MON, '10:00', '18:30')]);
    expect(c).toMatchObject({ arrivalAt: at(MON, '10:00'), lateSeconds: 3600, outsideScheduleSeconds: 3600 });
  });

  it('early leave beyond the tolerance, with a closed session and a finished day', () => {
    expect(day([closed(MON, '09:00', '18:20')])).toMatchObject({ earlyLeave: true, earlyLeaveSeconds: 600 });
    expect(day([closed(MON, '09:00', '18:25')]).earlyLeave).toBe(false);
    // Left during lunch and never came back.
    expect(day([closed(MON, '09:00', '13:30')])).toMatchObject({ earlyLeaveSeconds: 5 * 3600, lunchSeconds: 1800 });
    // Still open: not an early leave (the last heartbeat is 18:00).
    expect(day([open(at(MON, '09:00'), at(MON, '18:00'))]).earlyLeave).toBe(false);
    // Not decided while the schedule is running.
    const ongoing = day([closed(MON, '09:00', '17:00')], at(MON, '17:30'));
    expect(ongoing).toMatchObject({ state: 'ongoing', earlyLeave: false, expectedSoFarSeconds: 7.5 * 3600, offlineSeconds: 1800 });
  });

  it('several sessions merge (overlaps count once) and a session can cross the lunch', () => {
    const c = day([closed(MON, '09:00', '12:00'), closed(MON, '11:00', '15:00'), closed(MON, '16:00', '18:30')]);
    expect(c).toMatchObject({ inScheduleSeconds: 7.5 * 3600, lunchSeconds: 3600, offlineSeconds: 3600, connectedSeconds: 8.5 * 3600 });
    const cross = day([closed(MON, '12:00', '15:00')]);
    expect(cross).toMatchObject({ inScheduleSeconds: 2 * 3600, lunchSeconds: 3600, outsideScheduleSeconds: 0 });
  });

  it('open sessions count until min(now, last heartbeat)', () => {
    const s = open(at(MON, '09:00'), at(MON, '11:00'));
    expect(day([s], at(MON, '12:00'))).toMatchObject({ inScheduleSeconds: 2 * 3600, offlineSeconds: 3600, state: 'ongoing' });
    // Heartbeat ahead of `now` (clock skew): nothing counts after `now`.
    expect(day([open(at(MON, '09:00'), at(MON, '12:00'))], at(MON, '11:00')).inScheduleSeconds).toBe(2 * 3600);
  });

  it('today in progress: expected so far, lateness already known', () => {
    const c = day([open(at(MON, '09:30'), at(MON, '11:00'))], at(MON, '11:00'));
    expect(c).toMatchObject({
      state: 'ongoing',
      expectedSeconds: 8.5 * 3600,
      expectedSoFarSeconds: 2 * 3600,
      inScheduleSeconds: 1.5 * 3600,
      offlineSeconds: 1800,
      lateSeconds: 1800,
      absent: false,
    });
    expect(day([], at(MON, '08:00'))).toMatchObject({ state: 'upcoming', expectedSoFarSeconds: 0, offlineSeconds: 0, absent: false });
  });

  it('absence: a finished work day without sessions', () => {
    expect(day([])).toMatchObject({ absent: true, offlineSeconds: 8.5 * 3600, late: false });
    expect(day([], at(MON, '18:00')).absent).toBe(false);
    expect(day([], LATER, SAT).absent).toBe(false);
    expect(day([], LATER, MON, 5, [MON])).toMatchObject({ absent: false, holiday: true, workday: false, expectedSeconds: 0 });
    // Connected only after hours: not absent, but everything offline and outside.
    expect(day([closed(MON, '20:00', '21:00')])).toMatchObject({
      absent: false,
      offlineSeconds: 8.5 * 3600,
      outsideScheduleSeconds: 3600,
      arrivalAt: null,
      late: false,
    });
  });

  it('day off or holiday with a session: everything is outside the schedule', () => {
    expect(day([closed(SAT, '10:00', '12:00')], LATER, SAT)).toMatchObject({
      workday: false,
      expectedSeconds: 0,
      inScheduleSeconds: 0,
      lunchSeconds: 0,
      outsideScheduleSeconds: 2 * 3600,
      offlineSeconds: 0,
      late: false,
      earlyLeave: false,
    });
    expect(day([closed(MON, '08:00', '19:00')], LATER, MON, 5, [MON])).toMatchObject({
      outsideScheduleSeconds: 11 * 3600,
      lunchSeconds: 0,
    });
    expect(complianceForDay(MON, [closed(MON, '10:00', '11:00')], null, [], 5, LATER).outsideScheduleSeconds).toBe(3600);
  });

  it('a session crossing midnight counts on each day for its part', () => {
    const s = closed(SUN, '22:00', '10:00', MON);
    expect(day([s], LATER, SUN)).toMatchObject({ connectedSeconds: 2 * 3600, outsideScheduleSeconds: 2 * 3600 });
    expect(day([s])).toMatchObject({
      connectedSeconds: 10 * 3600,
      inScheduleSeconds: 3600,
      outsideScheduleSeconds: 9 * 3600,
      arrivalAt: at(MON, '09:00'),
      late: false,
      earlyLeaveSeconds: 8.5 * 3600, // left at 10:00: 8.5 h before 18:30
    });
  });

  it('daylight saving: September day (23 h) and April day (25 h)', () => {
    const sun: WeekSchedule = { ...emptyWeek(), sun: { start: '00:30', end: '08:00', lunchStart: null, lunchEnd: null } };
    // 00:30 does not exist on 2026-09-06: the day starts at 01:00.
    const sep = complianceForDay('2026-09-06', [], sun, [], 0, LATER);
    expect(sep).toMatchObject({ expectedSeconds: 7 * 3600, scheduledStart: iso('2026-09-06T04:00:00Z'), absent: true });
    const whole = closed('2026-09-06', '00:00', '00:00', '2026-09-07');
    expect(complianceForDay('2026-09-06', [whole], sun, [], 0, LATER)).toMatchObject({
      connectedSeconds: 23 * 3600,
      inScheduleSeconds: 7 * 3600,
      outsideScheduleSeconds: 16 * 3600,
      late: false,
    });

    const sat: WeekSchedule = { ...emptyWeek(), sat: { start: '20:00', end: '23:30', lunchStart: null, lunchEnd: null } };
    // 23:30 happens twice on 2026-04-04: the first one ends the day.
    const apr = complianceForDay('2026-04-04', [closed('2026-04-04', '00:00', '00:00', '2026-04-05')], sat, [], 0, LATER);
    expect(apr).toMatchObject({ expectedSeconds: 3.5 * 3600, inScheduleSeconds: 3.5 * 3600, connectedSeconds: 25 * 3600 });
    expect(apr.outsideScheduleSeconds).toBe(21.5 * 3600);

    // A normal schedule the day after each change keeps its 8.5 h.
    expect(complianceForDay('2026-09-07', [], WEEK, [], 5, LATER).expectedSeconds).toBe(8.5 * 3600);
    expect(complianceForDay('2026-04-06', [], WEEK, [], 5, LATER).expectedSeconds).toBe(8.5 * 3600);
  });
});

describe('complianceForRange', () => {
  it('adds up the days of the range (a holiday gives 0 expected)', () => {
    const sessions = [
      closed(MON, '09:10', '18:30'), // late 10 min
      closed('2026-09-29', '09:00', '18:00'), // early 30 min
      // Wednesday is a holiday here: connected time is all outside.
      closed('2026-09-30', '10:00', '11:00'),
      // Thursday absent.
      closed(FRI, '09:00', '14:00'),
      closed(SAT, '10:00', '10:30'),
    ];
    const r = complianceForRange(MON, '2026-10-04', sessions, WEEK, ['2026-09-30'], 5, LATER);
    expect(r.days.map((d) => d.date)).toEqual([MON, '2026-09-29', '2026-09-30', '2026-10-01', FRI, SAT, '2026-10-04']);
    expect(r.totals).toMatchObject({
      days: 7,
      workdays: 4,
      expectedSeconds: 3 * 8.5 * 3600 + 5 * 3600,
      lateCount: 1,
      lateSeconds: 600,
      earlyLeaveCount: 1,
      earlyLeaveSeconds: 1800,
      absentDays: 1,
      outsideScheduleSeconds: 3600 + 1800,
    });
    expect(r.totals.offlineSeconds).toBe(600 + 1800 + 8.5 * 3600);
    expect(r.totals.inScheduleSeconds + r.totals.offlineSeconds).toBe(r.totals.expectedSoFarSeconds);
    // Reversed bounds are swapped.
    expect(complianceForRange('2026-10-04', MON, sessions, WEEK, ['2026-09-30'], 5, LATER).totals).toEqual(r.totals);
  });

  it('rejects invalid dates and ranges that are too long', () => {
    expect(() => complianceForRange('2026-13-01', '2026-12-01', [], WEEK, [], 5, LATER)).toThrow('Fecha inválida');
    expect(() => complianceForRange('2026-01-01', '2027-12-31', [], WEEK, [], 5, LATER)).toThrow(RangeError);
  });
});
