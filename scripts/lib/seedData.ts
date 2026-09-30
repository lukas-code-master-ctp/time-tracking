/**
 * Pure generator of realistic demo data for `npm run seed` (no I/O).
 *
 * Working hours (spec 2026-09-30-horarios): the general schedule
 * {@link SEED_SCHEDULE} (Monday–Thursday 09:00–18:30 with lunch 13:00–14:00,
 * Friday 09:00–14:00, weekend off, Chilean holidays 2026–2027, tolerance 5,
 * reminders on) and one exception (Carla: half day 09:00–13:00, Monday to
 * Friday). The sessions follow each person's schedule in America/Santiago
 * (Beto closes the work day for the lunch, Ana keeps it open through it),
 * with variable activity per person and per block, typical Google Workspace
 * sites and time outside Chrome. Compliance cases: a late arrival (Beto, the
 * most recent past workday), an early leave (Ana, the second most recent),
 * overtime (Ana, the most recent), an absence (Carla, the second most recent)
 * and a forgotten "close" after hours on Wednesdays (Beto, auto close). Like
 * extension 0.2.0, activity blocks only measure time inside the working
 * windows: nothing in the lunch nor outside the schedule (a block that is all
 * lunch or off has no document), and screenshots are only taken in working
 * time. Holidays and days off have no sessions. Today: one open session right
 * now (Ana), one closed morning session (Beto), one person without data.
 *
 * Web meetings ("En reunión", spec 2026-09-30): a 30-minute daily at 09:30
 * every weekday, a weekly 1-hour meeting per person ({@link WEEKLY_MEETING}) and the
 * random video calls (task "meet") carry `meetingSeconds`. The oldest days
 * (`LEGACY_DAYS`) are written like extension 0.1.1: without `meetingSeconds`
 * (the portal reads it as 0). Deterministic for a given
 * `now` (seeded PRNG per person and day), so re-running the seed on the same
 * day produces the same documents.
 */
import {
  CHILE_HOLIDAY_DATES,
  DEFAULT_TOLERANCE_MINUTES,
  SLOT_MS,
  planForDay,
  slotStartOf,
  type ActivitySlot,
  type DaySchedule,
  type Interval,
  type ScheduleConfig,
  type Session,
  type SessionEndReason,
  type WeekSchedule,
} from '@timetracking/shared';
import { addDays, startOfDay, weekdayIndex, zonedDate, zonedParts } from '../../portal/src/lib/dates.ts';

const MIN = 60_000;

/** Days back (inclusive) written like extension 0.1.1, without `meetingSeconds`. */
export const LEGACY_DAYS = 6;

/** Daily stand-up: 09:30–10:00 (Santiago), every weekday. */
export const DAILY = { hour: 9, minute: 30, minutes: 30 } as const;

/** Weekly 1-hour meeting per person: weekday (0 = Monday) and hour (Santiago), inside their schedule. */
export const WEEKLY_MEETING: Readonly<Record<string, { weekday: number; hour: number }>> = {
  ana: { weekday: 0, hour: 15 },
  beto: { weekday: 2, hour: 15 },
  carla: { weekday: 3, hour: 11 }, // half day: until 13:00
};

// ---------- working hours ----------

const LJ: DaySchedule = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };

/** General week of `config/schedule` (the same values the portal suggests in "Crear horario"). */
export const SEED_WEEK: WeekSchedule = {
  mon: LJ,
  tue: LJ,
  wed: LJ,
  thu: LJ,
  fri: { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null },
  sat: null,
  sun: null,
};

/** `config/schedule` without `updatedAt` / `updatedBy` (the seed adds them). */
export const SEED_SCHEDULE: Omit<ScheduleConfig, 'updatedAt' | 'updatedBy'> = {
  week: SEED_WEEK,
  holidays: [...CHILE_HOLIDAY_DATES],
  toleranceMinutes: DEFAULT_TOLERANCE_MINUTES,
  remindersEnabled: true,
};

const HALF_DAY: DaySchedule = { start: '09:00', end: '13:00', lunchStart: null, lunchEnd: null };

/** Per-person exceptions (`schedules/{uid}`): Carla works half day, Monday to Friday. */
export const SEED_EXCEPTIONS: Readonly<Record<string, WeekSchedule>> = {
  carla: { mon: HALF_DAY, tue: HALF_DAY, wed: HALF_DAY, thu: HALF_DAY, fri: HALF_DAY, sat: null, sun: null },
};

/** Effective week of a person (the exception replaces only the week; holidays are the general ones). */
export function weekOf(personKey: string): WeekSchedule {
  return SEED_EXCEPTIONS[personKey] ?? SEED_WEEK;
}

export type Task = 'mail' | 'docs' | 'sheets' | 'drive' | 'calendar' | 'meet' | 'slides' | 'chat' | 'web' | 'whatsapp' | 'outside';

export interface SeedPerson {
  key: string;
  email: string;
  displayName: string;
  /** Mean activity % and its spread. */
  activity: number;
  spread: number;
  /** Relative weight of each task (how this person works). */
  tasks: Partial<Record<Task, number>>;
}

/** Collaborators of both Workspace organizations (`@compratuparcela.cl` and `@impulseai.cl`). */
export const PEOPLE: readonly SeedPerson[] = [
  {
    key: 'ana',
    email: 'ana.rojas@compratuparcela.cl',
    displayName: 'Ana Rojas',
    activity: 78,
    spread: 14,
    tasks: { mail: 3, docs: 3, sheets: 2, drive: 1, calendar: 1, meet: 1, chat: 1, web: 1, outside: 0.6 },
  },
  {
    key: 'beto',
    email: 'beto.diaz@compratuparcela.cl',
    displayName: 'Beto Díaz',
    activity: 55,
    spread: 20,
    tasks: { mail: 2, sheets: 4, drive: 2, meet: 2, calendar: 1, whatsapp: 1.5, web: 1.5, outside: 1.5 },
  },
  {
    key: 'carla',
    email: 'carla.soto@impulseai.cl',
    displayName: 'Carla Soto',
    activity: 66,
    spread: 18,
    tasks: { mail: 2, docs: 2, slides: 2, meet: 3, calendar: 2, chat: 1, drive: 1, outside: 1 },
  },
];

export const PENDING_INVITE = 'diego.munoz@impulseai.cl';

interface Site {
  domain: string;
  urls: string[];
}

export const SITES: Record<Exclude<Task, 'outside'>, Site[]> = {
  mail: [{ domain: 'mail.google.com', urls: ['https://mail.google.com/mail/u/0/', 'https://mail.google.com/mail/u/1/'] }],
  docs: [
    {
      domain: 'docs.google.com',
      urls: [
        'https://docs.google.com/document/d/1informe-ventas-septiembre/edit',
        'https://docs.google.com/document/d/1contrato-promesa-parcela-12/edit',
        'https://docs.google.com/document/d/1minuta-reunion-comercial/edit',
      ],
    },
  ],
  sheets: [
    {
      domain: 'sheets.google.com',
      urls: ['https://sheets.google.com/', 'https://sheets.google.com/u/0/'],
    },
    {
      domain: 'docs.google.com',
      urls: [
        'https://docs.google.com/spreadsheets/d/1pipeline-clientes-2026/edit',
        'https://docs.google.com/spreadsheets/d/1stock-parcelas-sur/edit',
      ],
    },
  ],
  drive: [{ domain: 'drive.google.com', urls: ['https://drive.google.com/drive/my-drive', 'https://drive.google.com/drive/folders/1proyectos-2026'] }],
  calendar: [{ domain: 'calendar.google.com', urls: ['https://calendar.google.com/calendar/u/0/r/week'] }],
  meet: [{ domain: 'meet.google.com', urls: ['https://meet.google.com/abc-defg-hij', 'https://meet.google.com/xyz-uvwx-rst'] }],
  slides: [{ domain: 'docs.google.com', urls: ['https://docs.google.com/presentation/d/1presentacion-directorio/edit'] }],
  chat: [{ domain: 'chat.google.com', urls: ['https://chat.google.com/room/equipo-ventas'] }],
  web: [
    { domain: 'compratuparcela.cl', urls: ['https://compratuparcela.cl/', 'https://compratuparcela.cl/parcelas/los-lagos'] },
    { domain: 'google.com', urls: ['https://www.google.com/search'] },
    { domain: 'sii.cl', urls: ['https://www.sii.cl/servicios_online/'] },
  ],
  whatsapp: [{ domain: 'web.whatsapp.com', urls: ['https://web.whatsapp.com/'] }],
};

/** Typical activity % per task (a video call has little keyboard/mouse). */
const TASK_ACTIVITY: Record<Task, number> = {
  mail: 0,
  docs: 8,
  sheets: 10,
  drive: -5,
  calendar: -8,
  meet: -35,
  slides: 4,
  chat: 0,
  web: -6,
  whatsapp: -4,
  outside: -10,
};

// ---------- PRNG ----------

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function pick<T>(r: () => number, weights: [T, number][]): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of weights) {
    x -= w;
    if (x <= 0) return v;
  }
  return weights[weights.length - 1]![0];
}

// ---------- local time ----------

/** Instant of `hh:mm` (wall clock in Santiago) on `date`. */
export function atLocal(date: string, hour: number, minute = 0): number {
  const start = startOfDay(date);
  const p = zonedParts(start);
  return start + (hour * 60 + minute - (p.hour * 60 + p.minute)) * MIN;
}

// ---------- output ----------

export interface SeedSession {
  id: string;
  data: Session;
}

export interface SeedShot {
  /** `{uid}_{slotStart}` like the extension. */
  id: string;
  uid: string;
  sessionId: string;
  takenAt: number;
  /** What the (blurred) image shows. */
  task: Task;
}

export interface SeedDataset {
  sessions: SeedSession[];
  activity: ActivitySlot[];
  shots: SeedShot[];
}

interface Span {
  start: number;
  end: number;
  lastHeartbeatAt: number;
  endReason: SessionEndReason | null;
}

/** Scheduled meetings of a person on `date` (the daily and, if it is that weekday, the 1-hour meeting). */
export function meetingWindows(person: SeedPerson, date: string): Interval[] {
  const daily = atLocal(date, DAILY.hour, DAILY.minute);
  const out: Interval[] = [{ start: daily, end: daily + DAILY.minutes * MIN }];
  const weekly = WEEKLY_MEETING[person.key];
  if (weekly && weekly.weekday === weekdayIndex(date)) {
    const start = atLocal(date, weekly.hour);
    out.push({ start, end: start + 60 * MIN });
  }
  return out;
}

/** What happens on a past workday (see the header). */
export type DayKind = 'normal' | 'late' | 'earlyLeave' | 'overtime' | 'absent';

/** Past workdays of a person (the 7 days before today, per their schedule and the holidays), oldest first. */
export function pastWorkdays(personKey: string, today: string): string[] {
  const out: string[] = [];
  for (let back = 7; back >= 1; back--) {
    const date = addDays(today, -back);
    if (planForDay(date, weekOf(personKey), SEED_SCHEDULE.holidays).work.length > 0) out.push(date);
  }
  return out;
}

/** Kind of each past workday: the most recent and the second most recent carry the compliance cases. */
export function dayKinds(personKey: string, workdays: readonly string[]): Map<string, DayKind> {
  const out = new Map<string, DayKind>(workdays.map((d) => [d, 'normal']));
  const set = (d: string | undefined, k: DayKind): void => {
    if (d) out.set(d, k);
  };
  const last = workdays[workdays.length - 1];
  const second = workdays[workdays.length - 2];
  if (personKey === 'beto') set(last, 'late');
  if (personKey === 'ana') {
    set(last, 'overtime');
    set(second, 'earlyLeave');
  }
  if (personKey === 'carla') set(second, 'absent');
  return out;
}

/**
 * Sessions of a past workday, following the person's schedule: arrival from
 * 12 min early to 4 min late (tolerance 5), exit up to 12 min after the end.
 * Beto and Carla close the work day for the lunch (two sessions); Ana keeps
 * it open through the lunch (one session; nothing is measured in the lunch).
 */
function pastDay(person: SeedPerson, date: string, r: () => number, kind: DayKind): Span[] {
  if (kind === 'absent') return [];
  const plan = planForDay(date, weekOf(person.key), SEED_SCHEDULE.holidays);
  if (!plan.span) return [];
  const minutes = (lo: number, hi: number): number => Math.round(between(r, lo, hi)) * MIN;
  const inM = plan.span.start + (kind === 'late' ? minutes(18, 22) : minutes(-12, 4));
  let out = plan.span.end + minutes(0, 12);
  if (kind === 'earlyLeave') out = plan.span.end - minutes(60, 75);
  if (kind === 'overtime') out = plan.span.end + minutes(40, 50);
  // Beto forgets to close on Wednesdays: Chrome stays open after hours and the
  // server closes the work day at the last heartbeat (time outside the schedule).
  const forgot = person.key === 'beto' && weekdayIndex(date) === 2 && kind === 'normal';
  if (forgot) out = plan.span.end + minutes(35, 50);
  const endReason: SessionEndReason = forgot ? 'auto' : 'manual';
  if (plan.lunch && person.key !== 'ana' && out > plan.lunch.end) {
    const lunch = plan.lunch.start + minutes(0, 6);
    const back = plan.lunch.end + minutes(-6, 3);
    return [
      { start: inM, end: lunch, lastHeartbeatAt: lunch, endReason: 'manual' },
      { start: back, end: out, lastHeartbeatAt: out, endReason },
    ];
  }
  return [{ start: inM, end: out, lastHeartbeatAt: out, endReason }];
}

/** Today's sessions (relative to `now`). */
function todaySpans(person: SeedPerson, date: string, now: number): Span[] {
  const hb = now - 30_000;
  if (person.key === 'ana') {
    // Open session "right now" (live in the portal).
    const start = Math.floor((now - 2 * 60 * MIN - 40 * MIN) / MIN) * MIN;
    return [{ start, end: hb, lastHeartbeatAt: hb, endReason: null }];
  }
  if (person.key === 'beto') {
    const start = atLocal(date, 9, 3);
    const end = Math.min(atLocal(date, 12, 40), now - 20 * MIN);
    return end - start >= 30 * MIN ? [{ start, end, lastHeartbeatAt: end, endReason: 'manual' }] : [];
  }
  return [];
}

function slotsOf(
  person: SeedPerson,
  uid: string,
  sessionId: string,
  span: Span,
  r: () => number,
  meetings: readonly Interval[],
  work: readonly Interval[],
  legacy: boolean,
): { slots: ActivitySlot[]; tasks: Task[] } {
  const slots: ActivitySlot[] = [];
  const tasks: Task[] = [];
  const weights = Object.entries(person.tasks) as [Task, number][];
  let task: Task = pick(r, weights);
  for (let s = slotStartOf(span.start); s < span.end; s += SLOT_MS) {
    const from = Math.max(span.start, s);
    const to = Math.min(span.end, s + SLOT_MS);
    // Extension 0.2.0: only the seconds inside the working windows are measured
    // (lunch and outside the schedule are a pause); a block without any has no document.
    let tracked = Math.floor(overlapMs(from, to, work) / 1000);
    if (tracked <= 0) continue;
    // Now and then a gap without data (computer asleep, browser closed).
    if (r() < 0.03) tracked = Math.floor(tracked * between(r, 0.2, 0.6));
    if (r() > 0.65) task = pick(r, weights);
    const scheduled = meetings.some((m) => s >= m.start && s < m.end);
    // In a scheduled meeting: the Meet tab in front, little keyboard/mouse.
    const blockTask: Task = scheduled ? 'meet' : task;
    const pct = scheduled
      ? between(r, 3, 15)
      : clamp(person.activity + TASK_ACTIVITY[blockTask] + (r() * 2 - 1) * person.spread, 3, 99);
    const active = Math.min(tracked, Math.round((tracked * pct) / 100));
    let outside = scheduled
      ? 0
      : blockTask === 'outside'
        ? Math.round(tracked * between(r, 0.6, 1))
        : r() < 0.25
          ? Math.round(tracked * between(r, 0.05, 0.3))
          : 0;
    outside = Math.min(outside, tracked);
    // A video call: most seconds without keyboard/mouse are "En reunión"
    // (a few are not: e.g. the call had not started yet). Extension 0.1.1
    // did not detect meetings.
    const meeting = blockTask === 'meet' && !legacy ? Math.round((tracked - active) * between(r, 0.85, 1)) : 0;
    const inChrome = tracked - outside;
    const domains: Record<string, number> = {};
    const urlSeconds = new Map<string, number>();
    const add = (t: Exclude<Task, 'outside'>, seconds: number): void => {
      if (seconds <= 0) return;
      const site = SITES[t][Math.floor(r() * SITES[t].length)]!;
      domains[site.domain] = (domains[site.domain] ?? 0) + seconds;
      const url = site.urls[Math.floor(r() * site.urls.length)]!;
      urlSeconds.set(url, (urlSeconds.get(url) ?? 0) + seconds);
    };
    if (inChrome > 0) {
      const main: Exclude<Task, 'outside'> = blockTask === 'outside' ? 'mail' : blockTask;
      const other = pick(r, weights.filter(([t]) => t !== 'outside' && t !== main) as [Exclude<Task, 'outside'>, number][]);
      const mainShare = Math.round(inChrome * (scheduled ? between(r, 0.85, 0.98) : between(r, 0.6, 0.95)));
      add(main, mainShare);
      add(other, inChrome - mainShare);
    }
    slots.push({
      uid,
      sessionId,
      slotStart: s,
      trackedSeconds: tracked,
      activeSeconds: active,
      // Extension 0.1.2 always sends it (0 without a meeting); 0.1.1 did not.
      ...(legacy ? {} : { meetingSeconds: Math.min(meeting, tracked - active) }),
      outsideChromeSeconds: outside,
      domains,
      urls: [...urlSeconds].map(([url, seconds]) => ({ url, seconds })).sort((a, b) => b.seconds - a.seconds),
    });
    tasks.push(blockTask);
  }
  return { slots, tasks };
}

function overlapMs(from: number, to: number, windows: readonly Interval[]): number {
  let total = 0;
  for (const w of windows) total += Math.max(0, Math.min(to, w.end) - Math.max(from, w.start));
  return total;
}

/**
 * Sessions, activity and screenshot plans for the 7 days before today plus
 * today. `uids` maps person key → Firebase uid.
 */
export function buildDataset(now: number, uids: Record<string, string>): SeedDataset {
  const today = zonedDate(now);
  const out: SeedDataset = { sessions: [], activity: [], shots: [] };
  for (const person of PEOPLE) {
    const uid = uids[person.key];
    if (!uid) throw new Error(`falta el uid de ${person.key}`);
    const kinds = dayKinds(person.key, pastWorkdays(person.key, today));
    for (let back = 7; back >= 0; back--) {
      const date = addDays(today, -back);
      const r = rng(`${person.key}:${date}`);
      const kind = kinds.get(date);
      if (back > 0 && !kind) continue; // weekend, holiday or day off in their schedule
      const spans = back === 0 ? todaySpans(person, date, now) : pastDay(person, date, r, kind!);
      const work = planForDay(date, weekOf(person.key), SEED_SCHEDULE.holidays).work;
      const dayShots: SeedShot[] = [];
      spans.forEach((span, i) => {
        const sessionId = `seed-${person.key}-${date}-${i + 1}`;
        out.sessions.push({
          id: sessionId,
          data: { uid, startedAt: span.start, endedAt: span.endReason ? span.end : null, endReason: span.endReason, lastHeartbeatAt: span.lastHeartbeatAt },
        });
        const { slots, tasks } = slotsOf(person, uid, sessionId, span, r, meetingWindows(person, date), work, back >= LEGACY_DAYS);
        out.activity.push(...slots);
        // Screenshots only on the two most recent days with data (retention demo, few files).
        if (back <= 1 || (back <= 3 && person.key === 'carla')) {
          slots.forEach((slot, j) => {
            if (r() > 0.18 || tasks[j] === 'outside') return; // outside Chrome → no capture
            // Only in working time: the extension does not capture in the lunch nor outside the schedule.
            const w = work.find((x) => x.start < slot.slotStart + SLOT_MS && x.end > slot.slotStart);
            if (!w) return;
            const lo = Math.max(slot.slotStart, span.start, w.start);
            const hi = Math.min(slot.slotStart + SLOT_MS - 30_000, span.end, w.end - 1_000, now - 60_000);
            if (hi <= lo) return;
            const takenAt = Math.floor(between(r, lo, hi));
            dayShots.push({ id: `${uid}_${slot.slotStart}`, uid, sessionId, takenAt, task: tasks[j]! });
          });
        }
      });
      out.shots.push(...dayShots.slice(0, 4));
    }
  }
  return out;
}
