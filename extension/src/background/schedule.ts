/**
 * Working hours in the extension (spec 2026-09-30-horarios.md, "Extensión
 * 0.2.0"). Pure helpers over the cached `config/schedule` + `schedules/{uid}`;
 * the wiring (reads, alarm, notifications) lives in app.ts and tracker.ts.
 *
 * - No valid `config/schedule` and no valid exception → no schedule: the
 *   extension measures whenever the work day is open, exactly as in 0.1.x.
 * - An exception alone (without `config/schedule`) still defines the week;
 *   holidays are then none, the tolerance the default, and there are no
 *   reminders (the spec ties them to `config/schedule.remindersEnabled`).
 * - Measurement is paused whenever `classifyInstant(now)` is not `'work'`
 *   (lunch, outside the schedule, day off, holiday).
 */
import {
  DEFAULT_TIME_ZONE,
  DEFAULT_TOLERANCE_MINUTES,
  WEEKDAY_NAMES,
  addDaysToDateKey,
  classifyInstant,
  dateKey,
  effectiveWeek,
  planForDay,
  readPersonSchedule,
  readScheduleConfig,
  zonedDayBounds,
  type DayPlan,
  type PersonSchedule,
  type ScheduleConfig,
  type WeekSchedule,
} from '@timetracking/shared';

/** `chrome.alarms` name of the next schedule transition / reminder / midnight. */
export const SCHEDULE_ALARM = 'tt-schedule';

/** Cached copy of the schedule docs (`tt.meta.schedule`). */
export interface ScheduleCache {
  /** User that read it (`schedules/{uid}` is per user). */
  uid: string;
  /** Valid `config/schedule`, or null (missing or invalid). */
  config: ScheduleConfig | null;
  /** Valid `schedules/{uid}`, or null (missing, invalid or not readable). */
  person: PersonSchedule | null;
  fetchedAt: number;
}

/** Re-validates a cache read from `chrome.storage.local` (older versions have none). */
export function scheduleCacheFromJSON(raw: unknown): ScheduleCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ScheduleCache>;
  if (typeof r.uid !== 'string' || !r.uid || typeof r.fetchedAt !== 'number' || !Number.isFinite(r.fetchedAt)) return null;
  return { uid: r.uid, config: readScheduleConfig(r.config), person: readPersonSchedule(r.person), fetchedAt: r.fetchedAt };
}

/** What the extension applies for one user. */
export interface EffectiveSchedule {
  week: WeekSchedule;
  holidays: readonly string[];
  toleranceMinutes: number;
  remindersEnabled: boolean;
}

/** The schedule of `uid` from the cache, or null = no schedule (measure as before). */
export function effectiveSchedule(cache: ScheduleCache | null | undefined, uid: string | null | undefined): EffectiveSchedule | null {
  if (!cache || !uid || cache.uid !== uid) return null;
  const week = effectiveWeek(cache.config, cache.person);
  if (!week) return null;
  return {
    week,
    holidays: cache.config?.holidays ?? [],
    toleranceMinutes: cache.config?.toleranceMinutes ?? DEFAULT_TOLERANCE_MINUTES,
    remindersEnabled: cache.config?.remindersEnabled === true,
  };
}

/** True when an open work day is measured at `ms` (always without a schedule). */
export function isMeasuringAt(schedule: EffectiveSchedule | null, ms: number): boolean {
  return schedule === null || classifyInstant(ms, schedule.week, schedule.holidays, DEFAULT_TIME_ZONE) === 'work';
}

function planOf(schedule: EffectiveSchedule, date: string): DayPlan {
  return planForDay(date, schedule.week, schedule.holidays, DEFAULT_TIME_ZONE);
}

const DAY_MS = 86_400_000;

/**
 * Instants in `(from, to]` where the measurement may pause or resume: starts
 * and ends of the working windows (entry, lunch start, lunch end, exit).
 * Only the last two days before `to` are looked at: a longer interval is a
 * gap the accumulator does not count anyway.
 */
export function pauseBoundaries(schedule: EffectiveSchedule | null, from: number, to: number): number[] {
  if (!schedule || !(to > from)) return [];
  const out = new Set<number>();
  const last = dateKey(to, DEFAULT_TIME_ZONE);
  for (let d = dateKey(Math.max(from, to - 2 * DAY_MS), DEFAULT_TIME_ZONE); d <= last; d = addDaysToDateKey(d, 1)) {
    for (const w of planOf(schedule, d).work) {
      for (const t of [w.start, w.end]) if (t > from && t <= to) out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------- popup ----------

export type ScheduleViewState = 'work' | 'lunch' | 'off' | 'holiday' | 'dayOff';

/** Schedule state for the popup (null = no schedule: the popup shows nothing new). */
export interface ScheduleView {
  state: ScheduleViewState;
  /** An open work day is measured right now. */
  measuring: boolean;
  /** "En horario hasta 18:30", "Colación hasta 14:00", "Fuera de horario: no se mide", "Hoy es feriado", "Día libre". */
  label: string;
  /** Today's schedule, e.g. "Hoy (miércoles): 09:00–18:30 · colación 13:00–14:00". */
  today: string;
}

export function scheduleView(schedule: EffectiveSchedule | null, now: number): ScheduleView | null {
  if (!schedule) return null;
  const plan = planOf(schedule, dateKey(now, DEFAULT_TIME_ZONE));
  const dayName = WEEKDAY_NAMES[plan.weekday].toLowerCase();
  if (plan.holiday) {
    return { state: 'holiday', measuring: false, label: 'Hoy es feriado', today: `Hoy (${dayName}): feriado, no se mide.` };
  }
  const day = plan.schedule;
  if (!day) return { state: 'dayOff', measuring: false, label: 'Día libre', today: `Hoy (${dayName}): día libre, no se mide.` };
  const lunch = day.lunchStart && day.lunchEnd ? ` · colación ${day.lunchStart}–${day.lunchEnd}` : '';
  const today = `Hoy (${dayName}): ${day.start}–${day.end}${lunch}`;
  const state = classifyInstant(now, schedule.week, schedule.holidays, DEFAULT_TIME_ZONE);
  if (state === 'work') {
    const beforeLunch = plan.lunch !== null && now < plan.lunch.start && day.lunchStart !== null;
    return { state, measuring: true, label: `En horario hasta ${beforeLunch ? day.lunchStart : day.end}`, today };
  }
  if (state === 'lunch') return { state, measuring: false, label: `Colación hasta ${day.lunchEnd ?? day.end}`, today };
  return { state: 'off', measuring: false, label: 'Fuera de horario: no se mide', today };
}

// ---------- reminders ----------

export type ReminderKind = 'start' | 'end';

/** Reminders already handled today (`tt.meta.reminders`): one per event and day. */
export interface ReminderLog {
  /** `YYYY-MM-DD` (America/Santiago). */
  date: string;
  done: ReminderKind[];
}

export function reminderLogFromJSON(raw: unknown): ReminderLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ReminderLog>;
  if (typeof r.date !== 'string' || !Array.isArray(r.done)) return null;
  return { date: r.date, done: r.done.filter((k): k is ReminderKind => k === 'start' || k === 'end') };
}

export interface Reminder {
  kind: ReminderKind;
  date: string;
  /** Instant of the reminder: entry/exit + tolerance. */
  at: number;
  /** Wall-clock entry/exit time (`HH:MM`) for the text. */
  time: string;
}

/** Reminders of `date`: none on a holiday, a day off or with reminders disabled. */
export function remindersForDay(schedule: EffectiveSchedule | null, date: string): Reminder[] {
  if (!schedule || !schedule.remindersEnabled) return [];
  const plan = planOf(schedule, date);
  if (!plan.span || !plan.schedule || plan.work.length === 0) return [];
  const tol = Math.max(0, schedule.toleranceMinutes) * 60_000;
  return [
    { kind: 'start', date, at: plan.span.start + tol, time: plan.schedule.start },
    { kind: 'end', date, at: plan.span.end + tol, time: plan.schedule.end },
  ];
}

export interface ReminderDecision {
  /** Log to persist (today's, with the events handled now). */
  log: ReminderLog;
  /** Notifications to show now. */
  notify: Reminder[];
  /** The log changed (persist it). */
  changed: boolean;
}

/**
 * Which reminders are due at `now`. An event is handled once, the first
 * time it is evaluated after its instant, whether or not a notification is
 * shown: "start" only notifies without an open work day and before the exit
 * (after that it is pointless); "end" only with the work day still open.
 */
export function decideReminders(
  schedule: EffectiveSchedule | null,
  now: number,
  workDayOpen: boolean,
  log: ReminderLog | null,
): ReminderDecision {
  const date = dateKey(now, DEFAULT_TIME_ZONE);
  const fresh = !log || log.date !== date;
  const next: ReminderLog = fresh ? { date, done: [] } : { date, done: [...log.done] };
  const notify: Reminder[] = [];
  const reminders = remindersForDay(schedule, date);
  const exit = reminders.find((r) => r.kind === 'end');
  for (const r of reminders) {
    if (now < r.at || next.done.includes(r.kind)) continue;
    next.done.push(r.kind);
    if (r.kind === 'start' && !workDayOpen && exit && now < exit.at - schedule!.toleranceMinutes * 60_000) notify.push(r);
    if (r.kind === 'end' && workDayOpen) notify.push(r);
  }
  const changed = fresh ? log !== null || next.done.length > 0 : next.done.length !== log.done.length;
  return { log: next, notify, changed };
}

/** Notification texts (Spanish). */
export function reminderText(r: Reminder): { message: string; button: string } {
  return r.kind === 'start'
    ? { message: `Tu jornada empezó a las ${r.time}. ¿Iniciar jornada?`, button: 'Iniciar jornada' }
    : { message: `Tu horario terminó a las ${r.time}. ¿Cerrar jornada?`, button: 'Cerrar jornada' };
}

const NOTIFICATION_PREFIX = 'tt-reminder';

export function reminderNotificationId(r: Pick<Reminder, 'kind' | 'date'>): string {
  return `${NOTIFICATION_PREFIX}:${r.kind}:${r.date}`;
}

export function parseReminderNotificationId(id: string): { kind: ReminderKind; date: string } | null {
  const m = /^tt-reminder:(start|end):(\d{4}-\d{2}-\d{2})$/.exec(id);
  return m ? { kind: m[1] as ReminderKind, date: m[2]! } : null;
}

// ---------- alarm ----------

/**
 * Next instant after `now` when something changes: a pause boundary, a
 * reminder, or the next midnight (a new day, re-planned then). Null without
 * a schedule.
 */
export function nextScheduleWake(schedule: EffectiveSchedule | null, now: number): number | null {
  if (!schedule) return null;
  const date = dateKey(now, DEFAULT_TIME_ZONE);
  const midnight = zonedDayBounds(date, DEFAULT_TIME_ZONE).end;
  const candidates = [
    ...planOf(schedule, date).work.flatMap((w) => [w.start, w.end]),
    ...remindersForDay(schedule, date).map((r) => r.at),
    midnight,
  ].filter((t) => t > now);
  return Math.min(...candidates);
}
