import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_VERSION,
  SLOT_MS,
  SlotAccumulator,
  zonedDateTimeToMs,
  type ActivitySlot,
  type ScheduleConfig,
  type WeekSchedule,
} from '@timetracking/shared';
import {
  SCHEDULE_ALARM,
  decideReminders,
  effectiveSchedule,
  nextScheduleWake,
  parseReminderNotificationId,
  pauseBoundaries,
  reminderLogFromJSON,
  reminderText,
  remindersForDay,
  scheduleCacheFromJSON,
  scheduleView,
  type EffectiveSchedule,
} from '../src/background/schedule';
import { PULSE_ALARM } from '../src/background/session';
import { STORAGE_KEYS } from '../src/background/state';
import { START_SCHEDULE_TIMEOUT_MS } from '../src/background/app';
import { activity, createHarness, hello, type Harness } from './fakes';

// Monday 2026-10-05 (Chile on summer time, UTC-3). 2026-10-12 is a holiday.
const MON = '2026-10-05';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const HOLIDAY = '2026-10-12';
const at = (date: string, time: string, seconds = 0): number => zonedDateTimeToMs(date, time) + seconds * 1000;

const LJ = { start: '09:00', end: '18:30', lunchStart: '13:00', lunchEnd: '14:00' };
const WEEK: WeekSchedule = {
  mon: LJ,
  tue: LJ,
  wed: LJ,
  thu: LJ,
  fri: { start: '09:00', end: '14:00', lunchStart: null, lunchEnd: null },
  sat: null,
  sun: null,
};
const CONFIG: ScheduleConfig = {
  week: WEEK,
  holidays: [HOLIDAY],
  toleranceMinutes: 5,
  remindersEnabled: true,
  updatedAt: 1,
  updatedBy: 'admin',
};
const EFFECTIVE: EffectiveSchedule = { week: WEEK, holidays: [HOLIDAY], toleranceMinutes: 5, remindersEnabled: true };

async function useSchedule(h: Harness, config: unknown, person?: unknown): Promise<void> {
  h.backend.schedule = config;
  if (person !== undefined) h.backend.personSchedules.set('u1', person);
  await h.app.refreshSchedule(0);
  await h.app.scheduleTick();
}

/** Snapshot of the block in progress (without emitting it). */
function current(h: Harness): ActivitySlot | null {
  const acc = h.app.store.acc;
  if (!acc) return null;
  return SlotAccumulator.fromJSON(acc.toJSON()).flush(acc.lastEventAt ?? Date.now()).current;
}

/**
 * Plays Chrome's alarms until `end`: the 30-second pulse (while it exists)
 * and the one-shot schedule alarm at its exact instant.
 */
async function runUntil(h: Harness, end: number): Promise<void> {
  let nextPulse = Date.now() + 30_000;
  while (Date.now() < end) {
    const sched = h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when;
    const next = Math.min(end, nextPulse, sched !== undefined && sched > Date.now() ? sched : Infinity);
    await vi.advanceTimersByTimeAsync(next - Date.now());
    if (sched !== undefined && Date.now() === sched) await h.app.onScheduleAlarm();
    if (Date.now() === nextPulse) {
      if (h.chrome.world.alarms.has(PULSE_ALARM)) await h.app.pulse();
      nextPulse += 30_000;
    }
    await h.settle();
  }
}

/** Sum of trackedSeconds uploaded (last snapshot of each block). */
function uploadedTracked(h: Harness): number {
  return [...h.backend.activity.values()].reduce((t, s) => t + s.trackedSeconds, 0);
}

describe('schedule helpers (pure)', () => {
  it('without config/schedule nor exception there is no schedule; an exception replaces the week', () => {
    expect(effectiveSchedule(null, 'u1')).toBeNull();
    expect(effectiveSchedule({ uid: 'u1', config: null, person: null, fetchedAt: 1 }, 'u1')).toBeNull();
    expect(effectiveSchedule({ uid: 'u1', config: CONFIG, person: null, fetchedAt: 1 }, 'u2')).toBeNull();
    const person = { week: { ...WEEK, mon: { start: '10:00', end: '12:00', lunchStart: null, lunchEnd: null } }, updatedAt: 1, updatedBy: 'a' };
    const both = effectiveSchedule({ uid: 'u1', config: CONFIG, person, fetchedAt: 1 }, 'u1')!;
    expect(both.week.mon).toEqual(person.week.mon);
    expect(both).toMatchObject({ holidays: [HOLIDAY], toleranceMinutes: 5, remindersEnabled: true });
    // Only the exception: its week, no holidays, default tolerance, no reminders.
    expect(effectiveSchedule({ uid: 'u1', config: null, person, fetchedAt: 1 }, 'u1')).toMatchObject({
      holidays: [],
      toleranceMinutes: 5,
      remindersEnabled: false,
    });
  });

  it('the cache read back from storage is validated again (invalid docs are dropped)', () => {
    expect(scheduleCacheFromJSON(undefined)).toBeNull();
    expect(scheduleCacheFromJSON({ uid: 'u1', fetchedAt: 'x' })).toBeNull();
    const c = scheduleCacheFromJSON({ uid: 'u1', config: { ...CONFIG, toleranceMinutes: 99 }, person: null, fetchedAt: 5 });
    expect(c).toEqual({ uid: 'u1', config: null, person: null, fetchedAt: 5 });
  });

  it('popup states: in schedule, lunch, outside, holiday, day off', () => {
    expect(scheduleView(null, at(MON, '10:00'))).toBeNull();
    const today = 'Hoy (lunes): 09:00–18:30 · colación 13:00–14:00';
    expect(scheduleView(EFFECTIVE, at(MON, '08:30'))).toEqual({ state: 'off', measuring: false, label: 'Fuera de horario: no se mide', today });
    expect(scheduleView(EFFECTIVE, at(MON, '10:00'))).toEqual({ state: 'work', measuring: true, label: 'En horario hasta 13:00', today });
    expect(scheduleView(EFFECTIVE, at(MON, '13:30'))).toEqual({ state: 'lunch', measuring: false, label: 'Colación hasta 14:00', today });
    expect(scheduleView(EFFECTIVE, at(MON, '15:00'))).toMatchObject({ label: 'En horario hasta 18:30' });
    expect(scheduleView(EFFECTIVE, at(MON, '19:00'))).toMatchObject({ state: 'off', label: 'Fuera de horario: no se mide' });
    expect(scheduleView(EFFECTIVE, at(FRI, '10:00'))).toEqual({
      state: 'work',
      measuring: true,
      label: 'En horario hasta 14:00',
      today: 'Hoy (viernes): 09:00–14:00',
    });
    expect(scheduleView(EFFECTIVE, at(HOLIDAY, '10:00'))).toMatchObject({ state: 'holiday', measuring: false, label: 'Hoy es feriado' });
    expect(scheduleView(EFFECTIVE, at(SAT, '10:00'))).toMatchObject({ state: 'dayOff', measuring: false, label: 'Día libre' });
  });

  it('pause boundaries and next wake-up (transition, reminder or midnight)', () => {
    expect(pauseBoundaries(EFFECTIVE, at(MON, '08:00'), at(MON, '20:00'))).toEqual([
      at(MON, '09:00'),
      at(MON, '13:00'),
      at(MON, '14:00'),
      at(MON, '18:30'),
    ]);
    // (from, to]: `from` itself excluded, `to` included.
    expect(pauseBoundaries(EFFECTIVE, at(MON, '09:00'), at(MON, '13:00'))).toEqual([at(MON, '13:00')]);
    expect(pauseBoundaries(null, 0, at(MON, '20:00'))).toEqual([]);
    expect(nextScheduleWake(EFFECTIVE, at(MON, '08:00'))).toBe(at(MON, '09:00'));
    // Reminders are at the exact times of the schedule (no tolerance), the same instants as the transitions.
    expect(nextScheduleWake(EFFECTIVE, at(MON, '09:00'))).toBe(at(MON, '13:00'));
    expect(nextScheduleWake(EFFECTIVE, at(MON, '13:00'))).toBe(at(MON, '14:00'));
    expect(nextScheduleWake(EFFECTIVE, at(MON, '14:00'))).toBe(at(MON, '18:30'));
    expect(nextScheduleWake(EFFECTIVE, at(MON, '18:30'))).toBe(at('2026-10-06', '00:00'));
    expect(nextScheduleWake(EFFECTIVE, at(SAT, '10:00'))).toBe(at('2026-10-11', '00:00'));
    expect(nextScheduleWake(null, at(MON, '08:00'))).toBeNull();
  });

  it('reminders: at the exact times (no tolerance), once per event and day, not on holidays nor without remindersEnabled', () => {
    expect(remindersForDay(EFFECTIVE, MON).map((r) => [r.kind, r.at])).toEqual([
      ['start', at(MON, '09:00')],
      ['lunchStart', at(MON, '13:00')],
      ['lunchEnd', at(MON, '14:00')],
      ['end', at(MON, '18:30')],
    ]);
    // Day without lunch: no lunch reminders. Holiday, day off, disabled: none.
    expect(remindersForDay(EFFECTIVE, FRI).map((r) => r.kind)).toEqual(['start', 'end']);
    expect(remindersForDay(EFFECTIVE, HOLIDAY)).toEqual([]);
    expect(remindersForDay(EFFECTIVE, SAT)).toEqual([]);
    expect(remindersForDay({ ...EFFECTIVE, remindersEnabled: false }, MON)).toEqual([]);

    const first = decideReminders(EFFECTIVE, at(MON, '09:00'), false, null);
    expect(first.notify).toEqual([{ kind: 'start', date: MON, at: at(MON, '09:00'), time: '09:00' }]);
    expect(decideReminders(EFFECTIVE, at(MON, '09:30'), false, first.log).notify).toEqual([]);
    // Too early (one second before), or with the work day open: nothing (and "start" is then handled).
    expect(decideReminders(EFFECTIVE, at(MON, '08:59', 59), false, null)).toMatchObject({ notify: [], changed: false });
    const open = decideReminders(EFFECTIVE, at(MON, '09:00'), true, null);
    expect(open.notify).toEqual([]);
    expect(decideReminders(EFFECTIVE, at(MON, '10:00'), false, open.log).notify).toEqual([]);
    // Exit at 18:30:00 exactly with the work day open (not at 18:35).
    expect(decideReminders(EFFECTIVE, at(MON, '18:29', 59), true, { date: MON, done: ['start', 'lunchStart', 'lunchEnd'] }).notify).toEqual([]);
    const end = decideReminders(EFFECTIVE, at(MON, '18:30'), true, { date: MON, done: ['start', 'lunchStart', 'lunchEnd'] });
    expect(end.notify).toEqual([{ kind: 'end', date: MON, at: at(MON, '18:30'), time: '18:30' }]);
    expect(decideReminders(EFFECTIVE, at(MON, '18:31'), true, end.log)).toMatchObject({ notify: [], changed: false });
    // Next day the log starts over.
    expect(decideReminders(EFFECTIVE, at('2026-10-06', '09:00'), false, end.log).notify).toHaveLength(1);
    expect(decideReminders(EFFECTIVE, at(HOLIDAY, '09:05'), false, null).notify).toEqual([]);
    expect(decideReminders(EFFECTIVE, at(SAT, '09:05'), false, null).notify).toEqual([]);
    expect(decideReminders({ ...EFFECTIVE, remindersEnabled: false }, at(MON, '09:05'), false, null).notify).toEqual([]);
  });

  it('lunch reminders: start and end with the work day open; "¿Retomar la jornada?" without it', () => {
    const morning = { date: MON, done: ['start' as const] };
    // Open work day.
    const lunch = decideReminders(EFFECTIVE, at(MON, '13:00'), true, morning);
    expect(lunch.notify).toEqual([{ kind: 'lunchStart', date: MON, at: at(MON, '13:00'), time: '13:00', until: '14:00' }]);
    expect(decideReminders(EFFECTIVE, at(MON, '12:59', 59), true, morning).notify).toEqual([]);
    const back = decideReminders(EFFECTIVE, at(MON, '14:00'), true, lunch.log);
    expect(back.notify).toEqual([{ kind: 'lunchEnd', date: MON, at: at(MON, '14:00'), time: '14:00' }]);
    expect(decideReminders(EFFECTIVE, at(MON, '14:10'), true, back.log).notify).toEqual([]);
    // Closed for the lunch: nothing at 13:00, the "resume" variant at 14:00.
    const closed = decideReminders(EFFECTIVE, at(MON, '13:00'), false, morning);
    expect(closed).toMatchObject({ notify: [], changed: true, log: { date: MON, done: ['start', 'lunchStart'] } });
    const resume = decideReminders(EFFECTIVE, at(MON, '14:00'), false, closed.log);
    expect(resume.notify).toEqual([{ kind: 'lunchEnd', date: MON, at: at(MON, '14:00'), time: '14:00', resume: true }]);
    // Friday has no lunch: nothing between entry and exit.
    expect(decideReminders(EFFECTIVE, at(FRI, '13:00'), true, { date: FRI, done: ['start'] }).notify).toEqual([]);

    // Texts, buttons and requireInteraction.
    const texts = [...lunch.notify, ...back.notify, ...resume.notify].map(reminderText);
    expect(texts).toEqual([
      { message: 'Es hora de tu colación (13:00–14:00). Durante la colación no se mide.', button: null, requireInteraction: false },
      { message: 'Terminó tu colación. Se vuelve a medir desde las 14:00.', button: null, requireInteraction: false },
      { message: 'Terminó tu colación. ¿Retomar la jornada?', button: 'Iniciar jornada', requireInteraction: false },
    ]);
    expect(reminderText(remindersForDay(EFFECTIVE, MON)[0]!)).toEqual({
      message: 'Tu jornada empieza a las 09:00. ¿Iniciar jornada?',
      button: 'Iniciar jornada',
      requireInteraction: true,
    });
    expect(reminderText(remindersForDay(EFFECTIVE, MON)[3]!)).toEqual({
      message: 'Tu horario terminó a las 18:30. ¿Cerrar jornada?',
      button: 'Cerrar jornada',
      requireInteraction: true,
    });
    expect(parseReminderNotificationId(`tt-reminder:lunchEnd:${MON}`)).toEqual({ kind: 'lunchEnd', date: MON });
    expect(parseReminderNotificationId(`tt-reminder:lunchStart:${MON}`)).toEqual({ kind: 'lunchStart', date: MON });
    expect(parseReminderNotificationId(`tt-reminder:lunch:${MON}`)).toBeNull();
  });

  it('late wake-up: each event once, and not after the next event of the day already happened', () => {
    // Woke up at 18:40 with the work day open: only the exit (no lunch reminders).
    const late = decideReminders(EFFECTIVE, at(MON, '18:40'), true, null);
    expect(late.notify.map((r) => r.kind)).toEqual(['end']);
    expect(late.log.done).toEqual(['start', 'lunchStart', 'lunchEnd', 'end']);
    // Opened Chrome after the exit without a work day: nothing at all.
    expect(decideReminders(EFFECTIVE, at(MON, '18:40'), false, null).notify).toEqual([]);
    // Woke up during the lunch (13:30): lunch start yes (its end did not happen yet), entry no.
    expect(decideReminders(EFFECTIVE, at(MON, '13:30'), true, null).notify.map((r) => r.kind)).toEqual(['lunchStart']);
    expect(decideReminders(EFFECTIVE, at(MON, '13:30'), false, null).notify).toEqual([]);
    // Woke up at 15:00 with the work day open: only the lunch end.
    expect(decideReminders(EFFECTIVE, at(MON, '15:00'), true, { date: MON, done: ['start'] }).notify.map((r) => r.kind)).toEqual(['lunchEnd']);
    // Late entry before the lunch still reminds; on Friday (no lunch) until the exit.
    expect(decideReminders(EFFECTIVE, at(MON, '12:00'), false, null).notify.map((r) => r.kind)).toEqual(['start']);
    expect(decideReminders(EFFECTIVE, at(FRI, '13:30'), false, null).notify.map((r) => r.kind)).toEqual(['start']);
  });

  it('a lunch at the edge of the schedule: the entry is not hidden, and no "Se vuelve a medir" at the exit', () => {
    const edges: EffectiveSchedule = {
      ...EFFECTIVE,
      week: { ...WEEK, mon: { start: '09:00', end: '18:30', lunchStart: '09:00', lunchEnd: '10:00' }, tue: { start: '09:00', end: '18:30', lunchStart: '17:30', lunchEnd: '18:30' } },
    };
    const TUE = '2026-10-06';
    // Lunch from the entry: without a work day, the entry reminder still shows at 09:00; with it open, the lunch one.
    expect(decideReminders(edges, at(MON, '09:00'), false, null).notify.map((r) => r.kind)).toEqual(['start']);
    expect(decideReminders(edges, at(MON, '09:00'), true, null).notify.map((r) => r.kind)).toEqual(['lunchStart']);
    // Lunch until the exit: no lunch-end reminder, only the exit.
    expect(remindersForDay(edges, TUE).map((r) => r.kind)).toEqual(['start', 'lunchStart', 'end']);
    expect(decideReminders(edges, at(TUE, '18:30'), true, { date: TUE, done: ['start', 'lunchStart'] }).notify.map((r) => r.kind)).toEqual(['end']);
  });

  it('a reminder log saved by 0.2.1 (only start/end) is read with the same keys', () => {
    expect(reminderLogFromJSON({ date: MON, done: ['start', 'end', 'other'] })).toEqual({ date: MON, done: ['start', 'end'] });
    expect(reminderLogFromJSON({ date: MON, done: ['lunchStart', 'lunchEnd'] })).toEqual({ date: MON, done: ['lunchStart', 'lunchEnd'] });
    expect(reminderLogFromJSON({ date: MON })).toBeNull();
    // 0.2.1 already showed today's entry: 0.2.2 does not repeat it, and adds the lunch.
    const old = reminderLogFromJSON({ date: MON, done: ['start'] });
    const d = decideReminders(EFFECTIVE, at(MON, '13:00'), true, old);
    expect(d.notify.map((r) => r.kind)).toEqual(['lunchStart']);
    expect(d.log.done).toEqual(['start', 'lunchStart']);
  });
});

describe('extension with working hours', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(MON, '08:00'));
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('without a schedule everything works as before (measures, no alarm, nothing new in the popup)', async () => {
    await useSchedule(h, null);
    expect((await h.app.status()).schedule).toBeNull();
    expect(h.chrome.world.alarms.has(SCHEDULE_ALARM)).toBe(false);
    await h.app.session.start();
    await runUntil(h, at(MON, '08:10', 30));
    expect(h.app.store.acc!.paused).toBe(false);
    expect(uploadedTracked(h) + (current(h)?.trackedSeconds ?? 0)).toBe(630);
    expect(h.chrome.world.notificationLog).toEqual([]);
  });

  it('work day open 08:00–19:00: full session, measured only 09:00–13:00 and 14:00–18:30, no captures in pause', async () => {
    h.backend.org = { ...h.backend.org!, screenshotsEnabled: true };
    await h.app.refreshOrgConfig(0);
    await useSchedule(h, CONFIG);
    expect(h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when).toBe(at(MON, '09:00'));
    await h.app.session.start();
    expect(h.app.store.acc!.paused).toBe(true);
    expect((await h.app.status()).schedule).toMatchObject({ label: 'Fuera de horario: no se mide' });

    await runUntil(h, at(MON, '10:00'));
    expect((await h.app.status()).schedule).toMatchObject({ label: 'En horario hasta 13:00', measuring: true });
    await runUntil(h, at(MON, '13:30'));
    expect((await h.app.status()).schedule).toMatchObject({ label: 'Colación hasta 14:00', measuring: false });
    await runUntil(h, at(MON, '19:00'));
    expect((await h.app.status()).schedule).toMatchObject({ label: 'Fuera de horario: no se mide' });
    await h.app.session.stop();
    await runUntil(h, at(MON, '19:11'));

    // The session covers the whole day, with heartbeats also in the pauses.
    const [session] = [...h.backend.sessions.values()];
    expect(session).toMatchObject({ startedAt: at(MON, '08:00'), endedAt: at(MON, '19:00'), endReason: 'manual' });
    const beats = h.backend.ops('heartbeat').map((c) => (c as { at: number }).at);
    expect(beats.some((t) => t > at(MON, '08:00') && t < at(MON, '09:00'))).toBe(true);
    expect(beats.some((t) => t > at(MON, '13:00') && t < at(MON, '14:00'))).toBe(true);
    expect(beats.some((t) => t > at(MON, '18:30'))).toBe(true);

    // Measured: 4 h + 4.5 h, only in blocks of the working windows.
    expect(uploadedTracked(h)).toBe(8.5 * 3600);
    const inWork = (t: number) => (t >= at(MON, '09:00') && t < at(MON, '13:00')) || (t >= at(MON, '14:00') && t < at(MON, '18:30'));
    for (const slot of h.backend.activity.values()) {
      expect(inWork(slot.slotStart)).toBe(true);
      expect(slot.trackedSeconds).toBe(600);
    }
    expect(h.backend.activity.size).toBe(51);
    expect((await h.app.status()).today.trackedSeconds).toBe(8.5 * 3600);

    // Screenshots only inside the working windows (one per measured block).
    const shots = [...h.backend.screenshots.values()];
    expect(shots.length).toBe(51);
    for (const s of shots) expect(inWork(s.takenAt)).toBe(true);
  });

  it('the transition applies at its exact instant: by the alarm, and also when the pulse comes late', async () => {
    await useSchedule(h, CONFIG);
    vi.setSystemTime(at(MON, '12:49', 50));
    await h.app.session.start();
    await runUntil(h, at(MON, '12:59', 50));
    expect(h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when).toBe(at(MON, '13:00'));
    await runUntil(h, at(MON, '13:00'));
    // The alarm fired at 13:00:00: paused before any pulse.
    expect(h.app.store.acc!.paused).toBe(true);
    expect(h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when).toBe(at(MON, '14:00'));
    await runUntil(h, at(MON, '13:05'));
    const block = h.backend.activity.get(`u1_${at(MON, '12:50')}`)!;
    expect(block.trackedSeconds).toBe(600); // 12:50:00–12:59:59 (from 12:50 on; start at 12:49:50 in the block before)
    expect(current(h)).toBeNull();

    // Resume at 14:00 without the alarm (e.g. the worker was busy): the pulse
    // at 14:00:20 attributes only 14:00:00–14:00:19.
    h.chrome.world.alarms.delete(SCHEDULE_ALARM);
    vi.setSystemTime(at(MON, '13:59', 50));
    await h.app.session.pulse();
    vi.setSystemTime(at(MON, '14:00', 20));
    await h.app.session.pulse();
    expect(h.app.store.acc!.paused).toBe(false);
    expect(current(h)).toMatchObject({ slotStart: at(MON, '14:00'), trackedSeconds: 20 });
  });

  it('a gap longer than 90 s across a boundary stays "no data" (not split at the boundary)', async () => {
    await useSchedule(h, CONFIG);
    vi.setSystemTime(at(MON, '12:58'));
    await h.app.session.start();
    for (const t of [30, 60, 90]) {
      vi.setSystemTime(at(MON, '12:58', t));
      await h.app.session.pulse();
    }
    // The worker slept 12:59:30 → 13:05:00 (no alarm, no pulse).
    h.chrome.world.alarms.delete(SCHEDULE_ALARM);
    vi.setSystemTime(at(MON, '13:05'));
    await h.app.session.pulse();
    await h.settle();
    expect(h.app.store.acc!.paused).toBe(true);
    // 12:58:00–12:59:29 only; 12:59:30–12:59:59 was not observed.
    expect(h.backend.activity.get(`u1_${at(MON, '12:50')}`)).toMatchObject({ trackedSeconds: 90 });
  });

  it('closing the work day just after a boundary does not measure the seconds of the lunch', async () => {
    await useSchedule(h, CONFIG);
    vi.setSystemTime(at(MON, '12:59'));
    await h.app.session.start();
    h.chrome.world.alarms.delete(SCHEDULE_ALARM);
    vi.setSystemTime(at(MON, '12:59', 58));
    await h.app.session.pulse();
    vi.setSystemTime(at(MON, '13:00', 25));
    await h.app.session.stop();
    await h.settle();
    expect(h.backend.activity.get(`u1_${at(MON, '12:50')}`)).toMatchObject({ trackedSeconds: 60 });
    expect(h.backend.activity.has(`u1_${at(MON, '13:00')}`)).toBe(false);
    expect(uploadedTracked(h)).toBe(60);
  });

  it('no screenshot in the lunch nor outside the schedule, even when forced', async () => {
    h.backend.org = { ...h.backend.org!, screenshotsEnabled: true };
    await h.app.refreshOrgConfig(0);
    await useSchedule(h, CONFIG);
    await h.app.session.start();
    expect(await h.app.screenshots.maybeCapture(true)).toBe('paused');
    vi.setSystemTime(at(MON, '13:30'));
    expect(await h.app.screenshots.maybeCapture(true)).toBe('paused');
    vi.setSystemTime(at(MON, '14:30'));
    expect(await h.app.screenshots.maybeCapture(true)).toBe('captured');
    expect(h.capturer.captures).toHaveLength(1);
  });

  it('a holiday measures nothing and has no reminders', async () => {
    vi.setSystemTime(at(HOLIDAY, '08:55'));
    await useSchedule(h, CONFIG);
    expect((await h.app.status()).schedule).toMatchObject({ state: 'holiday', label: 'Hoy es feriado' });
    await runUntil(h, at(HOLIDAY, '09:30'));
    await h.app.session.start();
    await runUntil(h, at(HOLIDAY, '19:00'));
    expect(uploadedTracked(h)).toBe(0);
    expect(current(h)).toBeNull();
    expect(h.chrome.world.notificationLog).toEqual([]);
  });

  it('an exception per person replaces the general week', async () => {
    const person = { week: { ...WEEK, mon: { start: '08:00', end: '12:00', lunchStart: null, lunchEnd: null } }, updatedAt: 1, updatedBy: 'admin' };
    await useSchedule(h, CONFIG, person);
    expect((await h.app.status()).schedule).toMatchObject({ label: 'En horario hasta 12:00', today: 'Hoy (lunes): 08:00–12:00' });
    await h.app.session.start();
    expect(h.app.store.acc!.paused).toBe(false);
  });

  describe('reminders', () => {
    it('start: one notification at the exact entry time, with a button that starts the work day', async () => {
      await useSchedule(h, CONFIG);
      await runUntil(h, at(MON, '08:59', 59));
      expect(h.chrome.world.notificationLog).toEqual([]);
      expect(h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when).toBe(at(MON, '09:00'));
      await runUntil(h, at(MON, '09:00'));
      expect(h.chrome.world.notificationLog).toHaveLength(1);
      const { id, options } = h.chrome.world.notificationLog[0]!;
      expect(id).toBe(`tt-reminder:start:${MON}`);
      expect(options).toMatchObject({
        type: 'basic',
        message: 'Tu jornada empieza a las 09:00. ¿Iniciar jornada?',
        buttons: [{ title: 'Iniciar jornada' }],
        requireInteraction: true,
      });
      // Only once, also after the worker restarts.
      await runUntil(h, at(MON, '09:20'));
      await h.restart();
      await h.app.scheduleTick();
      expect(h.chrome.world.notificationLog).toHaveLength(1);

      // (Chrome's listener, registered once, calls onReminderAction; the restarted app is called directly.)
      expect(h.chrome.events.notificationButton.listeners).toHaveLength(1);
      await h.app.onReminderAction(id);
      await h.settle();
      expect(h.app.store.session).not.toBeNull();
      expect(h.chrome.world.notifications.has(id)).toBe(false);
      expect(h.backend.ops('createSession')).toHaveLength(1);
    });

    it('start button without the current notice opens the notice instead', async () => {
      h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: '2026-09-30' };
      await useSchedule(h, CONFIG);
      await runUntil(h, at(MON, '09:00'));
      const { id } = h.chrome.world.notificationLog[0]!;
      await h.app.onReminderAction(id);
      expect(h.app.store.session).toBeNull();
      expect(h.chrome.world.openedTabs).toEqual(['chrome-extension://test-extension-id/consent.html']);
    });

    it('open work day: lunch start and end without a button, and the exit at 18:30:00 (not 18:35) with a button that closes it', async () => {
      await useSchedule(h, CONFIG);
      vi.setSystemTime(at(MON, '09:00'));
      await h.app.session.start();
      await h.app.scheduleTick();
      const log = h.chrome.world.notificationLog;
      await runUntil(h, at(MON, '12:59', 59));
      expect(log).toEqual([]);
      expect(h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when).toBe(at(MON, '13:00'));
      await runUntil(h, at(MON, '13:00'));
      expect(log.map((n) => n.id)).toEqual([`tt-reminder:lunchStart:${MON}`]);
      expect(log[0]!.options).toMatchObject({
        message: 'Es hora de tu colación (13:00–14:00). Durante la colación no se mide.',
        requireInteraction: false,
      });
      expect(log[0]!.options.buttons).toBeUndefined();
      await runUntil(h, at(MON, '14:00'));
      expect(log.map((n) => n.id)).toEqual([`tt-reminder:lunchStart:${MON}`, `tt-reminder:lunchEnd:${MON}`]);
      expect(log[1]!.options).toMatchObject({ message: 'Terminó tu colación. Se vuelve a medir desde las 14:00.', requireInteraction: false });
      expect(log[1]!.options.buttons).toBeUndefined();

      await runUntil(h, at(MON, '18:29', 59));
      expect(log).toHaveLength(2);
      expect(h.chrome.world.alarms.get(SCHEDULE_ALARM)?.when).toBe(at(MON, '18:30'));
      await runUntil(h, at(MON, '18:30'));
      expect(log.map((n) => n.id)).toEqual([`tt-reminder:lunchStart:${MON}`, `tt-reminder:lunchEnd:${MON}`, `tt-reminder:end:${MON}`]);
      expect(log[2]!.options).toMatchObject({
        message: 'Tu horario terminó a las 18:30. ¿Cerrar jornada?',
        buttons: [{ title: 'Cerrar jornada' }],
        requireInteraction: true,
      });
      // Once per event and day, also after a restart.
      await runUntil(h, at(MON, '18:40'));
      await h.restart();
      await h.app.scheduleTick();
      expect(log).toHaveLength(3);

      await h.app.onReminderAction(log[2]!.id);
      expect(h.app.store.session).toBeNull();
      expect(h.backend.sessions.size).toBe(1);
      await h.settle();
      expect(h.backend.ops('closeSession')).toHaveLength(1);
    });

    it('closed for the lunch: no lunch-start reminder, and at its end "¿Retomar la jornada?" with a button that starts it', async () => {
      await useSchedule(h, CONFIG);
      vi.setSystemTime(at(MON, '09:00'));
      await h.app.session.start();
      await h.app.scheduleTick();
      vi.setSystemTime(at(MON, '12:55'));
      await h.app.session.stop();
      await h.settle();
      const log = h.chrome.world.notificationLog;
      await runUntil(h, at(MON, '13:30'));
      expect(log).toEqual([]);
      await runUntil(h, at(MON, '14:00'));
      expect(log.map((n) => n.id)).toEqual([`tt-reminder:lunchEnd:${MON}`]);
      expect(log[0]!.options).toMatchObject({
        message: 'Terminó tu colación. ¿Retomar la jornada?',
        buttons: [{ title: 'Iniciar jornada' }],
        requireInteraction: false,
      });
      await h.app.onReminderAction(log[0]!.id);
      await h.settle();
      expect(h.app.store.session).not.toBeNull();
      expect(h.backend.ops('createSession')).toHaveLength(2);
      expect(h.chrome.world.notifications.has(log[0]!.id)).toBe(false);
      // A second click (e.g. the popup already resumed it) does nothing more.
      await h.app.onReminderAction(log[0]!.id);
      expect(h.backend.ops('createSession')).toHaveLength(2);
    });

    it('"¿Retomar la jornada?" without the current notice opens the notice; of another day, only the popup', async () => {
      h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: '2026-09-30' };
      await useSchedule(h, CONFIG);
      vi.setSystemTime(at(MON, '13:59'));
      await h.app.scheduleTick();
      await runUntil(h, at(MON, '14:00'));
      const { id } = h.chrome.world.notificationLog.find((n) => n.id.startsWith('tt-reminder:lunchEnd'))!;
      await h.app.onReminderAction(id);
      expect(h.app.store.session).toBeNull();
      expect(h.chrome.world.openedTabs).toEqual(['chrome-extension://test-extension-id/consent.html']);
      h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: CONSENT_VERSION };
      vi.setSystemTime(at('2026-10-06', '14:05'));
      await h.app.onReminderAction(id);
      expect(h.app.store.session).toBeNull();
      expect(h.chrome.world.popupOpened).toBe(1);
    });

    it('late wake-up after the exit (suspended computer): only the exit reminder, no lunch ones', async () => {
      await useSchedule(h, CONFIG);
      vi.setSystemTime(at(MON, '09:00'));
      await h.app.session.start();
      await h.app.scheduleTick();
      expect(h.chrome.world.notificationLog).toEqual([]);
      // Nothing runs 09:00 → 18:45 (no pulse, no alarm), then the worker wakes up.
      h.chrome.world.alarms.delete(SCHEDULE_ALARM);
      vi.setSystemTime(at(MON, '18:45'));
      await h.app.scheduleTick();
      expect(h.chrome.world.notificationLog.map((n) => n.id)).toEqual([`tt-reminder:end:${MON}`]);
      expect(h.app.store.meta.reminders).toEqual({ date: MON, done: ['start', 'lunchStart', 'lunchEnd', 'end'] });
    });

    it('a day without lunch (Friday) has no lunch reminders', async () => {
      vi.setSystemTime(at(FRI, '08:00'));
      await useSchedule(h, CONFIG);
      vi.setSystemTime(at(FRI, '09:00'));
      await h.app.session.start();
      await h.app.scheduleTick();
      await runUntil(h, at(FRI, '14:01'));
      expect(h.chrome.world.notificationLog.map((n) => n.id)).toEqual([`tt-reminder:end:${FRI}`]);
    });

    it('none without remindersEnabled, and none when the work day was already open', async () => {
      await useSchedule(h, { ...CONFIG, remindersEnabled: false });
      await runUntil(h, at(MON, '09:10'));
      expect(h.chrome.world.notificationLog).toEqual([]);
      vi.setSystemTime(at('2026-10-06', '08:50'));
      await useSchedule(h, CONFIG);
      await h.app.session.start();
      await runUntil(h, at('2026-10-06', '09:10'));
      await h.app.session.stop();
      await runUntil(h, at('2026-10-06', '10:00'));
      expect(h.chrome.world.notificationLog).toEqual([]);
    });

    it('a reminder of another day left in the notification center does not touch the work day of today', async () => {
      await useSchedule(h, CONFIG);
      vi.setSystemTime(at('2026-10-06', '09:00'));
      await h.app.session.start();
      await h.app.onReminderAction(`tt-reminder:end:${MON}`);
      expect(h.app.store.session).not.toBeNull();
      expect(h.chrome.world.popupOpened).toBe(1);
      await h.app.session.stop();
      await h.app.onReminderAction(`tt-reminder:start:${MON}`);
      expect(h.app.store.session).toBeNull();
      expect(h.chrome.world.popupOpened).toBe(2);
    });

    it('clicking the notification opens the popup (or the popup page in a tab)', async () => {
      await h.app.onReminderClicked(`tt-reminder:start:${MON}`);
      expect(h.chrome.world.popupOpened).toBe(1);
      h.chrome.world.openPopupFails = true;
      await h.app.onReminderClicked(`tt-reminder:end:${MON}`);
      expect(h.chrome.world.openedTabs).toEqual(['chrome-extension://test-extension-id/popup.html']);
      await h.app.onReminderClicked('other-notification');
      expect(h.chrome.world.openedTabs).toHaveLength(1);
    });
  });

  describe('starting the work day reads the schedule first (race of the e2e)', () => {
    /** Everything measured so far: uploaded blocks plus the one in progress. */
    const measured = (): number => uploadedTracked(h) + (current(h)?.trackedSeconds ?? 0);

    it('a schedule saved after the last read pauses from the very instant of the start (slow read)', async () => {
      // Fresh cache without a schedule (read at 08:00), then the admin saves one
      // that excludes now: the next start must not measure a single second.
      await useSchedule(h, null);
      await hello(h, 11);
      h.backend.schedule = CONFIG;
      h.backend.scheduleDelayMs = 1_500;
      const started = h.app.handlePopup({ type: 'session.start' });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await started).toMatchObject({ ok: true });
      h.backend.scheduleDelayMs = 0; // later reads (pulse, alarm) answer at once
      expect(h.app.store.acc!.paused).toBe(true);
      expect(h.app.store.session!.startedAt).toBe(at(MON, '08:00', 1.5));
      await activity(h, 11);
      vi.setSystemTime(at(MON, '08:00', 4));
      await activity(h, 11);
      await runUntil(h, at(MON, '08:12'));
      expect(measured()).toBe(0);
      expect((await h.app.status()).schedule).toMatchObject({ label: 'Fuera de horario: no se mide' });
    });

    it('the same with an instant read: paused before the first second', async () => {
      await useSchedule(h, null);
      h.backend.schedule = CONFIG;
      expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: true });
      expect(h.app.store.acc!.paused).toBe(true);
      vi.setSystemTime(at(MON, '08:00', 1));
      await activity(h, 11);
      await runUntil(h, at(MON, '08:12'));
      expect(measured()).toBe(0);
    });

    it('also from the "Iniciar jornada" button of a reminder', async () => {
      await useSchedule(h, null);
      h.backend.schedule = CONFIG;
      h.backend.scheduleDelayMs = 800;
      const started = h.app.onReminderAction(`tt-reminder:start:${MON}`);
      await vi.advanceTimersByTimeAsync(800);
      await started;
      h.backend.scheduleDelayMs = 0;
      expect(h.app.store.session).not.toBeNull();
      expect(h.app.store.acc!.paused).toBe(true);
      await runUntil(h, at(MON, '08:12'));
      expect(measured()).toBe(0);
    });

    it('a read that does not answer in time: starts with the cache, the schedule applies on arrival', async () => {
      await useSchedule(h, null);
      h.backend.schedule = CONFIG;
      h.backend.scheduleDelayMs = 10_000;
      const fetches = h.backend.scheduleFetches;
      const started = h.app.handlePopup({ type: 'session.start' });
      await vi.advanceTimersByTimeAsync(START_SCHEDULE_TIMEOUT_MS);
      expect(await started).toMatchObject({ ok: true });
      expect(h.app.store.session!.startedAt).toBe(at(MON, '08:00') + START_SCHEDULE_TIMEOUT_MS);
      expect(h.app.store.acc!.paused).toBe(false); // cached: no schedule
      await vi.advanceTimersByTimeAsync(10_000 - START_SCHEDULE_TIMEOUT_MS);
      await h.settle();
      h.backend.scheduleDelayMs = 0;
      expect(h.app.store.acc!.paused).toBe(true);
      expect(h.backend.scheduleFetches).toBe(fetches + 1); // read once for the start (not again after it)
      await runUntil(h, at(MON, '08:12'));
      // Only the seconds before the answer (documented limitation): 08:00:03–08:00:09.
      expect(measured()).toBe(10 - START_SCHEDULE_TIMEOUT_MS / 1000);
    });

    it('offline: starts right away with the cached schedule (paused)', async () => {
      await useSchedule(h, CONFIG);
      h.backend.offline = true;
      expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: true });
      expect(h.app.store.session!.startedAt).toBe(at(MON, '08:00'));
      expect(h.app.store.acc!.paused).toBe(true);
    });

    it('an older read that answers late never overwrites a newer one', async () => {
      await useSchedule(h, null);
      h.backend.scheduleDelayMs = 5_000;
      const fetches = h.backend.scheduleFetches;
      const slow = h.app.refreshSchedule(0); // sees "no schedule"
      await vi.advanceTimersByTimeAsync(0);
      expect(h.backend.scheduleFetches).toBe(fetches + 1);
      h.backend.schedule = CONFIG;
      h.backend.scheduleDelayMs = 0;
      await h.app.refreshSchedule(0); // sees CONFIG
      expect(h.app.store.meta.schedule?.config).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      await slow;
      expect(h.app.store.meta.schedule?.config).not.toBeNull();
    });

    it('a newer read that fails does not discard an older one that answers later', async () => {
      await useSchedule(h, null);
      h.backend.schedule = CONFIG;
      h.backend.scheduleDelayMs = 5_000;
      const slow = h.app.refreshSchedule(0); // sees CONFIG, answers late
      await vi.advanceTimersByTimeAsync(0);
      h.backend.scheduleDelayMs = 0;
      h.backend.scheduleFailures.push('unavailable');
      await h.app.refreshSchedule(0); // newer, fails: keeps the cache
      expect(h.app.store.meta.schedule?.config).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      await slow;
      expect(h.app.store.meta.schedule?.config).not.toBeNull();
    });

    it('two clicks during the read start a single work day', async () => {
      await useSchedule(h, null);
      h.backend.schedule = CONFIG;
      h.backend.scheduleDelayMs = 1_000;
      const first = h.app.handlePopup({ type: 'session.start' });
      const second = h.app.handlePopup({ type: 'session.start' });
      await vi.advanceTimersByTimeAsync(1_000);
      const answers = await Promise.all([first, second]);
      h.backend.scheduleDelayMs = 0;
      expect(answers.filter((r) => r.ok)).toHaveLength(1);
      expect(answers.find((r) => !r.ok)).toMatchObject({ reason: 'already-open' });
      await h.settle();
      expect(h.backend.ops('createSession')).toHaveLength(1);
      expect(h.app.store.acc!.paused).toBe(true);
    });

    it('without the current notice: answers at once, without waiting for (or making) the read', async () => {
      await useSchedule(h, CONFIG);
      h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: '2026-09-30' };
      h.backend.scheduleDelayMs = 10_000;
      const fetches = h.backend.scheduleFetches;
      expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: false, reason: 'consent-required' });
      await h.app.onReminderAction(`tt-reminder:start:${MON}`);
      expect(h.chrome.world.openedTabs).toEqual(['chrome-extension://test-extension-id/consent.html']);
      expect(h.backend.scheduleFetches).toBe(fetches);
      expect(h.app.store.session).toBeNull();
    });

    it('signed out: answers at once, without reading the schedule', async () => {
      await useSchedule(h, CONFIG);
      await h.app.handlePopup({ type: 'auth.signOut' });
      h.backend.scheduleDelayMs = 10_000;
      const fetches = h.backend.scheduleFetches;
      expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: false, reason: 'signed-out' });
      expect(h.backend.scheduleFetches).toBe(fetches);
    });
  });

  describe('cache and compatibility', () => {
    it('offline: the cached schedule keeps pausing after a restart; a failed read keeps the cache', async () => {
      await useSchedule(h, CONFIG);
      expect(h.chrome.local.data[STORAGE_KEYS.meta]).toMatchObject({ schedule: { uid: 'u1', config: { toleranceMinutes: 5 } } });
      h.backend.offline = true;
      vi.setSystemTime(at(MON, '13:10'));
      await h.restart();
      expect((await h.app.status()).schedule).toMatchObject({ label: 'Colación hasta 14:00' });
      h.backend.offline = false;
      h.backend.scheduleFailures = ['unavailable'];
      await h.app.refreshSchedule(0);
      expect(h.app.store.meta.schedule?.config).not.toBeNull();
      await h.app.session.start();
      expect(h.app.store.acc!.paused).toBe(true);
    });

    it('re-read every 5 minutes; a new schedule applies right away', async () => {
      await useSchedule(h, null);
      await h.app.session.start();
      const before = h.backend.scheduleFetches;
      h.backend.schedule = CONFIG;
      await runUntil(h, at(MON, '08:04', 30));
      expect(h.backend.scheduleFetches).toBe(before);
      expect(h.app.store.acc!.paused).toBe(false);
      await runUntil(h, at(MON, '08:05', 30));
      expect(h.backend.scheduleFetches).toBe(before + 1);
      expect(h.app.store.acc!.paused).toBe(true);
    });

    it('an invalid config/schedule is ignored (no schedule, measures as before)', async () => {
      await useSchedule(h, { ...CONFIG, week: { ...WEEK, mon: { start: '18:00', end: '09:00', lunchStart: null, lunchEnd: null } } });
      expect(h.app.store.meta.schedule).toMatchObject({ config: null, person: null });
      expect((await h.app.status()).schedule).toBeNull();
    });

    it('state saved by 0.1.x (accumulator without pause, meta without schedule) loads and keeps measuring', async () => {
      await h.app.session.start();
      await runUntil(h, at(MON, '08:01'));
      const acc = h.chrome.local.data[STORAGE_KEYS.acc] as Record<string, unknown>;
      delete acc.paused;
      const meta = h.chrome.local.data[STORAGE_KEYS.meta] as Record<string, unknown>;
      delete meta.schedule;
      delete meta.reminders;
      await h.restart();
      expect((await h.app.status()).schedule).toBeNull();
      expect(h.app.store.acc!.paused).toBe(false);
      await runUntil(h, at(MON, '08:02'));
      expect(current(h)).toMatchObject({ trackedSeconds: 120 });
      // Then the admin configures a schedule: from now on 08:xx is not measured.
      await useSchedule(h, CONFIG);
      await runUntil(h, at(MON, '08:03'));
      expect(current(h)).toMatchObject({ trackedSeconds: 120 });
    });

    it('signing out forgets the schedule and its alarm', async () => {
      await useSchedule(h, CONFIG);
      expect(h.chrome.world.alarms.has(SCHEDULE_ALARM)).toBe(true);
      await h.app.handlePopup({ type: 'auth.signOut' });
      expect(h.app.store.meta.schedule).toBeNull();
      expect(h.chrome.world.alarms.has(SCHEDULE_ALARM)).toBe(false);
    });
  });

  it('the notice version was raised for the working hours', () => {
    expect(CONSENT_VERSION).toBe('2026-09-30.2');
    expect(SLOT_MS).toBe(600_000);
  });
});
