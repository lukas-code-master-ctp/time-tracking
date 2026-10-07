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

/**
 * Lunches of the schedule that overlap a work day open since `startedAt`, up
 * to the end of the day of `now` (so a lunch still ahead today is included
 * and the popup clock stops at its start without asking again). The popup
 * clock leaves them out when `config/org.pauseTimerAtLunch` is on.
 */
export function lunchPauses(schedule: EffectiveSchedule | null, startedAt: number, now: number): { start: number; end: number }[] {
  if (!schedule || !(now >= startedAt)) return [];
  const out: { start: number; end: number }[] = [];
  const last = dateKey(now, DEFAULT_TIME_ZONE);
  for (let d = dateKey(Math.max(startedAt, now - 2 * DAY_MS), DEFAULT_TIME_ZONE); d <= last; d = addDaysToDateKey(d, 1)) {
    const lunch = planOf(schedule, d).lunch;
    if (lunch && lunch.end > startedAt) out.push({ start: Math.max(lunch.start, startedAt), end: lunch.end });
  }
  return out;
}

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

/**
 * Events with a reminder, in the order they happen in a day (spec
 * 2026-10-02-notificaciones-hora-exacta-colacion.md): entry, lunch start,
 * lunch end, exit. 0.2.1 only had `start` and `end`; a log it saved
 * (`tt.meta.reminders`) is read as is, with the same keys.
 */
export const REMINDER_KINDS = ['start', 'lunchStart', 'lunchEnd', 'end'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

function isReminderKind(k: unknown): k is ReminderKind {
  return typeof k === 'string' && (REMINDER_KINDS as readonly string[]).includes(k);
}

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
  return { date: r.date, done: r.done.filter(isReminderKind) };
}

export interface Reminder {
  kind: ReminderKind;
  date: string;
  /** Instant of the reminder: the exact time of the event (no tolerance). */
  at: number;
  /** Wall-clock time of the event (`HH:MM`) for the text. */
  time: string;
  /** Only `lunchStart`: wall-clock end of the lunch, for "(14:00–15:00)". */
  until?: string;
  /**
   * Only `lunchEnd`: there was no open work day at that instant (it was
   * closed for the lunch), so the reminder offers to resume it.
   */
  resume?: true;
}

/**
 * Reminders of `date`, in order, at the exact times of the schedule (the
 * tolerance only counts for late arrivals and early exits in the reports):
 * none on a holiday, a day off or with reminders disabled; no lunch
 * reminders on a day without lunch.
 */
export function remindersForDay(schedule: EffectiveSchedule | null, date: string): Reminder[] {
  if (!schedule || !schedule.remindersEnabled) return [];
  const plan = planOf(schedule, date);
  const day = plan.schedule;
  if (!plan.span || !day || plan.work.length === 0) return [];
  const out: Reminder[] = [{ kind: 'start', date, at: plan.span.start, time: day.start }];
  if (plan.lunch && day.lunchStart !== null && day.lunchEnd !== null) {
    out.push({ kind: 'lunchStart', date, at: plan.lunch.start, time: day.lunchStart, until: day.lunchEnd });
    // A lunch that ends with the schedule has no "Se vuelve a medir" (nothing is measured after it): only the exit.
    if (plan.lunch.end < plan.span.end) out.push({ kind: 'lunchEnd', date, at: plan.lunch.end, time: day.lunchEnd });
  }
  out.push({ kind: 'end', date, at: plan.span.end, time: day.end });
  return out;
}

/**
 * The lunch reminders without a button (lunch start, and lunch end with the
 * work day open) are only informative: evaluated later than this after
 * their time (late wake-up), they are handled without a notification.
 */
export const INFO_REMINDER_WINDOW_MS = 15 * 60_000;

export interface ReminderDecision {
  /** Log to persist (today's, with the events handled now). */
  log: ReminderLog;
  /** Notifications to show now. */
  notify: Reminder[];
  /** The log changed (persist it). */
  changed: boolean;
}

/** The notification of `r` with this state of the work day, or null (none). */
function variantFor(r: Reminder, workDayOpen: boolean): Reminder | null {
  switch (r.kind) {
    case 'start':
      return workDayOpen ? null : r;
    case 'lunchStart':
    case 'end':
      return workDayOpen ? r : null;
    case 'lunchEnd':
      return workDayOpen ? r : { ...r, resume: true };
  }
}

/**
 * Which reminders are due at `now`. Each event is handled once per day, the
 * first time it is evaluated at or after its exact instant (pulse, alarm or
 * a late wake-up, e.g. after a suspended computer), whether or not a
 * notification is shown. It notifies with the state of the work day of its
 * row in the spec (entry and "¿Retomar la jornada?" without an open work
 * day; lunch start, lunch end and exit with it open) and only if the next
 * event of the day has not happened yet: a late wake-up after the exit shows
 * no lunch reminder, nor the entry one. The informative lunch reminders
 * (without a button) also need to be within INFO_REMINDER_WINDOW_MS of their time.
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
  reminders.forEach((r, i) => {
    if (now < r.at || next.done.includes(r.kind)) return;
    next.done.push(r.kind);
    // Too late: the next event of the day (strictly later; e.g. a lunch that
    // starts with the schedule does not hide the entry) already happened.
    const following = reminders.slice(i + 1).find((f) => f.at > r.at);
    if (following && now >= following.at) return;
    const shown = variantFor(r, workDayOpen);
    if (!shown) return;
    const informative = shown.kind === 'lunchStart' || (shown.kind === 'lunchEnd' && !shown.resume);
    if (informative && now > r.at + INFO_REMINDER_WINDOW_MS) return; // stale: not worth a notification
    notify.push(shown);
  });
  const changed = fresh ? log !== null || next.done.length > 0 : next.done.length !== log.done.length;
  return { log: next, notify, changed };
}

export interface ReminderContent {
  message: string;
  /** Title of the only button, or null (no button). */
  button: string | null;
  /** Entry and exit stay until the person acts; the lunch ones go away by themselves. */
  requireInteraction: boolean;
}

/** Notification texts (Spanish). */
export function reminderText(r: Reminder): ReminderContent {
  switch (r.kind) {
    case 'start':
      return { message: `Tu jornada empieza a las ${r.time}. ¿Iniciar jornada?`, button: 'Iniciar jornada', requireInteraction: true };
    case 'lunchStart':
      return {
        message: `Es hora de tu colación (${r.time}–${r.until ?? ''}). Durante la colación no se mide.`,
        button: null,
        requireInteraction: false,
      };
    case 'lunchEnd':
      return r.resume
        ? { message: 'Terminó tu colación. ¿Retomar la jornada?', button: 'Iniciar jornada', requireInteraction: false }
        : { message: `Terminó tu colación. Se vuelve a medir desde las ${r.time}.`, button: null, requireInteraction: false };
    case 'end':
      return { message: `Tu horario terminó a las ${r.time}. ¿Cerrar jornada?`, button: 'Cerrar jornada', requireInteraction: true };
  }
}

const NOTIFICATION_PREFIX = 'tt-reminder';

export function reminderNotificationId(r: Pick<Reminder, 'kind' | 'date'>): string {
  return `${NOTIFICATION_PREFIX}:${r.kind}:${r.date}`;
}

export function parseReminderNotificationId(id: string): { kind: ReminderKind; date: string } | null {
  const m = /^tt-reminder:(start|lunchStart|lunchEnd|end):(\d{4}-\d{2}-\d{2})$/.exec(id);
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
