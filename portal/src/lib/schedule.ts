/**
 * Working hours in the portal (spec 2026-09-30-horarios.md): the editor's
 * form model, the documents written (exactly as `firestore.rules` accepts
 * them) and the compliance shown in Equipo and in the collaborator detail.
 * Pure: the caller passes the admin uid and the clock.
 *
 * The validation messages are the ones of `@timetracking/shared`
 * (`validateWeekSchedule`, `validateHolidays`, `validateToleranceMinutes`),
 * the same functions the extension uses to accept a document.
 */
import {
  CHILE_HOLIDAY_DATES,
  DEFAULT_TOLERANCE_MINUTES,
  MAX_HOLIDAYS,
  WEEKDAYS,
  WEEKDAY_NAMES,
  chileHolidayName,
  complianceForDay,
  complianceForRange,
  effectiveWeek,
  isValidDateKey,
  normalizeHolidays,
  planForDay,
  secondsToHours,
  validateHolidays,
  validateToleranceMinutes,
  validateWeekSchedule,
  weekdayOfDateKey,
  type ComplianceTotals,
  type DayCompliance,
  type DayPlan,
  type DaySchedule,
  type PersonSchedule,
  type ScheduleConfig,
  type ScheduleIssue,
  type Session,
  type TeamCsvExtra,
  type WeekSchedule,
  type Weekday,
} from '@timetracking/shared';
import { formatShortDate, zonedDate } from './dates';

// ---------- form model ----------

/** One day of the editor. The times are kept when the day or the lunch is turned off, to restore them. */
export interface DayForm {
  /** Working day (false = "Libre"). */
  enabled: boolean;
  /** `HH:MM` as typed (`<input type="time">`; '' when cleared). */
  start: string;
  end: string;
  lunch: boolean;
  lunchStart: string;
  lunchEnd: string;
}

export type WeekForm = Record<Weekday, DayForm>;

export interface ScheduleForm {
  week: WeekForm;
  /** Raw text of the input. */
  toleranceMinutes: string;
  remindersEnabled: boolean;
  /** `YYYY-MM-DD`, sorted. */
  holidays: string[];
}

const LJ: DaySchedule = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };

/**
 * Suggested week when an admin creates the schedule: Monday to Thursday
 * 09:00–18:30 with lunch 13:00–14:00, Friday 09:00–14:00 without lunch,
 * weekend off.
 */
export const DEFAULT_WEEK: WeekSchedule = Object.freeze({
  mon: LJ,
  tue: LJ,
  wed: LJ,
  thu: LJ,
  fri: { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null },
  sat: null,
  sun: null,
});

/** Times shown when a day off or a day without lunch is turned on. */
const BLANK_DAY: DayForm = { enabled: false, start: '09:00', end: '18:00', lunch: false, lunchStart: '13:00', lunchEnd: '14:00' };

export function dayToForm(day: DaySchedule | null): DayForm {
  if (!day) return { ...BLANK_DAY };
  const lunch = day.lunchStart !== null && day.lunchEnd !== null;
  return {
    enabled: true,
    start: day.start,
    end: day.end,
    lunch,
    lunchStart: lunch ? day.lunchStart! : BLANK_DAY.lunchStart,
    lunchEnd: lunch ? day.lunchEnd! : BLANK_DAY.lunchEnd,
  };
}

export function formToDay(form: DayForm): DaySchedule | null {
  if (!form.enabled) return null;
  return {
    start: form.start,
    end: form.end,
    lunchStart: form.lunch ? form.lunchStart : null,
    lunchEnd: form.lunch ? form.lunchEnd : null,
  };
}

export function weekToForm(week: WeekSchedule): WeekForm {
  return Object.fromEntries(WEEKDAYS.map((wd) => [wd, dayToForm(week[wd])])) as WeekForm;
}

export function formToWeek(form: WeekForm): WeekSchedule {
  return Object.fromEntries(WEEKDAYS.map((wd) => [wd, formToDay(form[wd])])) as WeekSchedule;
}

/** Form of a new general schedule: {@link DEFAULT_WEEK}, the Chilean holidays, tolerance 5, reminders on. */
export function defaultScheduleForm(): ScheduleForm {
  return {
    week: weekToForm(DEFAULT_WEEK),
    toleranceMinutes: String(DEFAULT_TOLERANCE_MINUTES),
    remindersEnabled: true,
    holidays: normalizeHolidays(CHILE_HOLIDAY_DATES),
  };
}

export function scheduleToForm(config: ScheduleConfig): ScheduleForm {
  return {
    week: weekToForm(config.week),
    toleranceMinutes: String(config.toleranceMinutes),
    remindersEnabled: config.remindersEnabled,
    holidays: normalizeHolidays(config.holidays),
  };
}

/** "Copiar lunes a martes–viernes". */
export function copyMondayToWeekdays(week: WeekForm): WeekForm {
  const mon = week.mon;
  return { ...week, tue: { ...mon }, wed: { ...mon }, thu: { ...mon }, fri: { ...mon } };
}

// ---------- validation ----------

/** Minutes typed in the tolerance input, or NaN (so the shared message is used). */
export function parseTolerance(raw: string): number {
  const t = raw.trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : Number.NaN;
}

export function validateWeekForm(week: WeekForm): ScheduleIssue[] {
  return validateWeekSchedule(formToWeek(week));
}

/** Every problem of the form ([] = it can be saved). */
export function validateScheduleForm(form: ScheduleForm): ScheduleIssue[] {
  return [
    ...validateWeekForm(form.week),
    ...validateToleranceMinutes(parseTolerance(form.toleranceMinutes)),
    ...validateHolidays(form.holidays),
  ];
}

/** Messages of one day (`week.mon`, `week.mon.start`…), without repeats. */
export function dayMessages(issues: readonly ScheduleIssue[], weekday: Weekday): string[] {
  const prefix = `week.${weekday}`;
  return [...new Set(issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`)).map((i) => i.message))];
}

/** Messages whose path starts with `root` (`toleranceMinutes`, `holidays`). */
export function messagesOf(issues: readonly ScheduleIssue[], root: string): string[] {
  return [...new Set(issues.filter((i) => i.path === root || i.path.startsWith(`${root}.`) || i.path.startsWith(`${root}[`)).map((i) => i.message))];
}

// ---------- documents ----------

/** `config/schedule` with the 6 fields the rules require (`updatedBy` = caller). Throws when invalid. */
export function buildScheduleConfig(form: ScheduleForm, uid: string, now: number): ScheduleConfig {
  const issues = validateScheduleForm(form);
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(' '));
  return {
    week: formToWeek(form.week),
    holidays: normalizeHolidays(form.holidays),
    toleranceMinutes: parseTolerance(form.toleranceMinutes),
    remindersEnabled: form.remindersEnabled,
    updatedAt: Math.floor(now),
    updatedBy: uid,
  };
}

/** `schedules/{uid}` with the 3 fields the rules require. Throws when invalid. */
export function buildPersonSchedule(week: WeekForm, adminUid: string, now: number): PersonSchedule {
  const issues = validateWeekForm(week);
  if (issues.length > 0) throw new Error(issues.map((i) => i.message).join(' '));
  return { week: formToWeek(week), updatedAt: Math.floor(now), updatedBy: adminUid };
}

// ---------- holidays ----------

export type HolidayChange = { ok: true; holidays: string[] } | { ok: false; error: string };

export function addHoliday(holidays: readonly string[], raw: string): HolidayChange {
  const date = raw.trim();
  if (!date) return { ok: false, error: 'Elige la fecha del feriado.' };
  if (!isValidDateKey(date)) return { ok: false, error: 'La fecha no es válida.' };
  if (holidays.includes(date)) return { ok: false, error: `El ${formatShortDate(date)} ya está en la lista.` };
  if (holidays.length >= MAX_HOLIDAYS) {
    return { ok: false, error: `Puedes guardar hasta ${MAX_HOLIDAYS} feriados. Quita los de años pasados.` };
  }
  return { ok: true, holidays: normalizeHolidays([...holidays, date]) };
}

/** Adds the missing Chilean holidays 2026–2027; `added` = how many were new. */
export function addChileHolidays(holidays: readonly string[]): { holidays: string[]; added: number } {
  const missing = CHILE_HOLIDAY_DATES.filter((d) => !holidays.includes(d));
  return { holidays: normalizeHolidays([...holidays, ...missing]), added: missing.length };
}

export function removeHoliday(holidays: readonly string[], date: string): string[] {
  return holidays.filter((d) => d !== date);
}

/** Drops the dates before `today` (they no longer change anything and count against the 60). */
export function removePastHolidays(holidays: readonly string[], today: string): { holidays: string[]; removed: number } {
  const kept = holidays.filter((d) => d >= today);
  return { holidays: kept, removed: holidays.length - kept.length };
}

const SHORT_WEEKDAY: Record<Weekday, string> = { mon: 'lun', tue: 'mar', wed: 'mié', thu: 'jue', fri: 'vie', sat: 'sáb', sun: 'dom' };

export interface HolidayLabel {
  date: string;
  /** "vie 18-09-2026" */
  label: string;
  /** Name when it is a Chilean national holiday. */
  name: string | null;
}

export function holidayLabel(date: string): HolidayLabel {
  const valid = isValidDateKey(date);
  return {
    date,
    label: valid ? `${SHORT_WEEKDAY[weekdayOfDateKey(date)]} ${formatShortDate(date)}` : date,
    name: valid ? chileHolidayName(date) : null,
  };
}

// ---------- descriptions ----------

/** "09:00–18:30, colación 13:00–14:00", "09:00–14:00, sin colación" or "Libre". */
export function describeDay(day: DaySchedule | null): string {
  if (!day) return 'Libre';
  return day.lunchStart && day.lunchEnd
    ? `${day.start}–${day.end}, colación ${day.lunchStart}–${day.lunchEnd}`
    : `${day.start}–${day.end}, sin colación`;
}

function sameDay(a: DaySchedule | null, b: DaySchedule | null): boolean {
  return describeDay(a) === describeDay(b);
}

/**
 * The week grouped by consecutive equal days: ["Lunes a jueves: 09:00–18:30,
 * colación 13:00–14:00", "Viernes: 09:00–14:00, sin colación", "Sábado y
 * domingo: libre"].
 */
export function describeWeek(week: WeekSchedule): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < WEEKDAYS.length) {
    let j = i;
    while (j + 1 < WEEKDAYS.length && sameDay(week[WEEKDAYS[i]!], week[WEEKDAYS[j + 1]!])) j++;
    const first = WEEKDAY_NAMES[WEEKDAYS[i]!];
    const last = WEEKDAY_NAMES[WEEKDAYS[j]!].toLowerCase();
    const days = i === j ? first : j === i + 1 ? `${first} y ${last}` : `${first} a ${last}`;
    const text = describeDay(week[WEEKDAYS[i]!]);
    out.push(`${days}: ${text === 'Libre' ? 'libre' : text}`);
    i = j + 1;
  }
  return out;
}

// ---------- compliance ----------

export type ScheduleSource = 'general' | 'personal' | 'none';

/** What the pages load once: the general schedule and the exceptions by uid. */
export interface ScheduleContext {
  config: ScheduleConfig | null;
  persons: ReadonlyMap<string, PersonSchedule>;
}

export interface EffectiveSchedule {
  source: ScheduleSource;
  week: WeekSchedule | null;
  /** Always the general ones (none without a general schedule, as in the extension). */
  holidays: readonly string[];
  toleranceMinutes: number;
}

/** Schedule of one person, as the extension applies it (spec, "Decisiones de implementación (Tarea 2)"). */
export function scheduleFor(ctx: ScheduleContext, uid: string): EffectiveSchedule {
  const person = ctx.persons.get(uid) ?? null;
  const week = effectiveWeek(ctx.config, person);
  return {
    source: person ? 'personal' : ctx.config ? 'general' : 'none',
    week,
    holidays: ctx.config?.holidays ?? [],
    toleranceMinutes: ctx.config?.toleranceMinutes ?? DEFAULT_TOLERANCE_MINUTES,
  };
}

/** True when anybody in `uids` has a schedule (general, or an exception). */
export function anySchedule(ctx: ScheduleContext, uids: readonly string[]): boolean {
  return ctx.config !== null || uids.some((u) => ctx.persons.has(u));
}

export interface MemberCompliance {
  source: ScheduleSource;
  /** null without a schedule. */
  totals: ComplianceTotals | null;
}

export interface TeamCompliance {
  byUid: Map<string, MemberCompliance>;
  /** Sum over the people with a schedule. */
  totals: ComplianceTotals;
  /** People with a schedule. */
  scheduled: number;
}

function zeroTotals(): ComplianceTotals {
  return {
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
}

export function addTotals(a: ComplianceTotals, b: ComplianceTotals): ComplianceTotals {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof ComplianceTotals)[]) out[k] += b[k];
  return out;
}

/**
 * First day that counts for a person: the day they joined (`createdAt`), or
 * the day of an earlier session (seeded or imported data), never before
 * `fromDate`. Without `joinedAt` it is `fromDate`.
 */
export function complianceStartDate(fromDate: string, joinedAt: number | undefined, sessions: readonly Session[]): string {
  if (joinedAt === undefined || !Number.isFinite(joinedAt)) return fromDate;
  let first = zonedDate(joinedAt);
  for (const s of sessions) {
    const d = zonedDate(s.startedAt);
    if (d < first) first = d;
  }
  return first > fromDate ? first : fromDate;
}

/**
 * Compliance of each person over `fromDate..toDate`, from the sessions
 * already loaded for the team table (no extra reads). null when nobody has a
 * schedule: the columns are not shown. `joinedAt` (uid → `createdAt`) keeps
 * the days before someone joined out of the count: a person invited on the
 * 20th has no absences nor offline time from the 1st to the 19th.
 */
export function teamCompliance(
  uids: readonly string[],
  sessions: readonly Session[],
  ctx: ScheduleContext,
  fromDate: string,
  toDate: string,
  now: number,
  joinedAt?: ReadonlyMap<string, number>,
): TeamCompliance | null {
  if (!anySchedule(ctx, uids)) return null;
  const byPerson = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byPerson.get(s.uid);
    if (list) list.push(s);
    else byPerson.set(s.uid, [s]);
  }
  const byUid = new Map<string, MemberCompliance>();
  let totals = zeroTotals();
  let scheduled = 0;
  for (const uid of uids) {
    const eff = scheduleFor(ctx, uid);
    if (!eff.week) {
      byUid.set(uid, { source: 'none', totals: null });
      continue;
    }
    const own = byPerson.get(uid) ?? [];
    const start = complianceStartDate(fromDate, joinedAt?.get(uid), own);
    // Joined after the period: nothing expected from them in it.
    const personTotals =
      start > toDate
        ? zeroTotals()
        : complianceForRange(start, toDate, own, eff.week, eff.holidays, eff.toleranceMinutes, now).totals;
    byUid.set(uid, { source: eff.source, totals: personTotals });
    totals = addTotals(totals, personTotals);
    scheduled++;
  }
  return { byUid, totals, scheduled };
}

export const SOURCE_LABEL: Record<ScheduleSource, string> = {
  general: 'General',
  personal: 'Personalizado',
  none: 'Sin horario',
};

/** Extra CSV columns: the same figures as the table's schedule columns. */
export function complianceCsvExtra(tc: TeamCompliance): TeamCsvExtra {
  return {
    columns: [
      { key: 'scheduleSource', header: 'Horario' },
      { key: 'expectedHours', header: 'Horas esperadas' },
      { key: 'expectedSoFarHours', header: 'Horas esperadas a la fecha' },
      { key: 'inScheduleHours', header: 'Horas en horario' },
      { key: 'outsideScheduleHours', header: 'Horas fuera de horario' },
      { key: 'lateCount', header: 'Atrasos' },
      { key: 'lateHours', header: 'Horas de atraso' },
      { key: 'offlineHours', header: 'Horas sin conexión en horario' },
      { key: 'absentDays', header: 'Ausencias (días)' },
    ],
    values(row) {
      const c = tc.byUid.get(row.uid);
      const t = c?.totals;
      if (!c || !t) return { scheduleSource: SOURCE_LABEL.none };
      return {
        scheduleSource: SOURCE_LABEL[c.source],
        expectedHours: secondsToHours(t.expectedSeconds),
        expectedSoFarHours: secondsToHours(t.expectedSoFarSeconds),
        inScheduleHours: secondsToHours(t.inScheduleSeconds),
        outsideScheduleHours: secondsToHours(t.outsideScheduleSeconds),
        lateCount: t.lateCount,
        lateHours: secondsToHours(t.lateSeconds),
        offlineHours: secondsToHours(t.offlineSeconds),
        absentDays: t.absentDays,
      };
    },
  };
}

// ---------- one day (collaborator detail) ----------

export interface DayScheduleView {
  source: ScheduleSource;
  plan: DayPlan;
  compliance: DayCompliance;
  /** Chilean holiday name when the day is a holiday with a known name. */
  holidayName: string | null;
  /** Outside the schedule and in the lunch, per session (same order as `sessions`). */
  perSession: Map<string, { outsideScheduleSeconds: number; lunchSeconds: number }>;
}

/** Plan and compliance of `date` for one person; null without a schedule. */
export function dayScheduleView(
  date: string,
  sessions: readonly (Session & { id: string })[],
  eff: EffectiveSchedule,
  now: number,
): DayScheduleView | null {
  if (!eff.week) return null;
  const plan = planForDay(date, eff.week, eff.holidays);
  const compliance = complianceForDay(date, sessions, eff.week, eff.holidays, eff.toleranceMinutes, now);
  const perSession = new Map<string, { outsideScheduleSeconds: number; lunchSeconds: number }>();
  for (const s of sessions) {
    const c = complianceForDay(date, [s], eff.week, eff.holidays, eff.toleranceMinutes, now);
    perSession.set(s.id, { outsideScheduleSeconds: c.outsideScheduleSeconds, lunchSeconds: c.lunchSeconds });
  }
  return { source: eff.source, plan, compliance, holidayName: plan.holiday ? chileHolidayName(date) : null, perSession };
}
