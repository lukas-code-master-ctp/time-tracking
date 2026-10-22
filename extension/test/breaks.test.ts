import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_BREAK_EXERCISES, dailyExercise, zonedDateTimeToMs, type ActiveBreakSettings } from '@timetracking/shared';
import {
  BREAK_SNOOZE_MS,
  DAILY_MIN_GAP_MS,
  answerBreak,
  breakDoc,
  breakStateFromJSON,
  breakText,
  breakTick,
  emptyBreakState,
  nextBreakAt,
  parseBreakNotificationId,
  type BreakState,
  type BreakTickInput,
} from '../src/background/breaks';
import { NO_SCHEDULE_BREAK_DAY_MS, breakWindows, type EffectiveSchedule } from '../src/background/schedule';
import { PULSE_ALARM } from '../src/background/session';
import { isPopupRequest } from '../src/messages';
import { ORG, createHarness, type Harness } from './fakes';

const MIN = 60_000;
const T0 = zonedDateTimeToMs('2026-10-05', '09:00');
const SETTINGS: ActiveBreakSettings = { enabled: true, mode: 'interval', intervalMinutes: 60, perDay: 3, durationMinutes: 5 };

function input(now: number, over: Partial<BreakTickInput> = {}): BreakTickInput {
  return { now, uid: 'u1', settings: SETTINGS, optedOut: false, sessionId: 's1', measuring: true, idle: 'active', inMeeting: false, windows: [], ...over };
}

/** Ticks every 30 s from `from` to `to` (inclusive), like the pulse; returns the state and the reminders shown. */
function run(state: BreakState | null, from: number, to: number, over: (t: number) => Partial<BreakTickInput> = () => ({})) {
  const prompts: number[] = [];
  let s = state;
  for (let t = from; t <= to; t += 30_000) {
    const r = breakTick(s, input(t, over(t)));
    s = r.state;
    if (r.prompt) prompts.push(r.prompt.at);
  }
  return { state: s!, prompts };
}

describe('active breaks (pure)', () => {
  it('reminds after 60 min of continuous work, with a rotating exercise, and not again for another interval', () => {
    const { state, prompts } = run(null, T0, T0 + 60 * MIN);
    expect(prompts).toEqual([T0 + 60 * MIN]);
    expect(state.pending).toEqual({ at: T0 + 60 * MIN, sessionId: 's1', exercise: ACTIVE_BREAK_EXERCISES[0]!.id });
    // Unanswered: the next one an interval later replaces it, with the next exercise.
    const quiet = run(state, T0 + 60.5 * MIN, T0 + 119.5 * MIN);
    expect(quiet.prompts).toEqual([]);
    const r = breakTick(quiet.state, input(T0 + 120 * MIN));
    expect(r.prompt?.exercise).toBe(ACTIVE_BREAK_EXERCISES[1]!.id);
    expect(r.replaced).toEqual(state.pending);
  });

  it('being away for the duration of the break (or a gap without pulses) starts the count again', () => {
    // Away 09:30–09:35 (5 min): the count restarts at 09:35.
    const away = (t: number) => (t >= T0 + 30 * MIN && t < T0 + 35 * MIN ? { idle: 'idle' as const } : {});
    expect(run(null, T0, T0 + 95 * MIN, away).prompts).toEqual([T0 + 95 * MIN]);
    // Away only 4 min: it does not count as a break.
    const short = (t: number) => (t >= T0 + 30 * MIN && t < T0 + 34 * MIN ? { idle: 'locked' as const } : {});
    expect(run(null, T0, T0 + 60 * MIN, short).prompts).toEqual([T0 + 60 * MIN]);
    // Asleep 09:30–09:40 (no ticks).
    const before = run(null, T0, T0 + 30 * MIN).state;
    expect(run(before, T0 + 40 * MIN, T0 + 99 * MIN).prompts).toEqual([]);
    expect(run(before, T0 + 40 * MIN, T0 + 100 * MIN).prompts).toEqual([T0 + 100 * MIN]);
  });

  it('waits for the end of a meeting; nothing without a work day, outside the schedule, off, or turned off by the person', () => {
    const meeting = (t: number) => (t >= T0 + 50 * MIN && t < T0 + 70 * MIN ? { inMeeting: true } : {});
    expect(run(null, T0, T0 + 80 * MIN, meeting).prompts).toEqual([T0 + 70 * MIN]);
    for (const over of [{ sessionId: null }, { measuring: false }, { optedOut: true }, { settings: { ...SETTINGS, enabled: false } }, { settings: null }]) {
      expect(run(null, T0, T0 + 120 * MIN, () => over).prompts).toEqual([]);
    }
    // Lunch (not measured) in the middle resets the count.
    const lunch = (t: number) => (t >= T0 + 40 * MIN && t < T0 + 100 * MIN ? { measuring: false } : {});
    expect(run(null, T0, T0 + 159 * MIN, lunch).prompts).toEqual([]);
    expect(run(null, T0, T0 + 160 * MIN, lunch).prompts).toEqual([T0 + 160 * MIN]);
  });

  it('answers: taken restarts the count, postponed waits 10 min, another state or reminder is ignored', () => {
    const { state } = run(null, T0, T0 + 60 * MIN);
    const at = T0 + 60 * MIN;
    const taken = answerBreak(state, at, 'taken', at + 7 * MIN, 5);
    expect(taken.doc).toEqual({
      uid: 'u1',
      sessionId: 's1',
      status: 'taken',
      promptedAt: at,
      answeredAt: at + 7 * MIN,
      start: at + 2 * MIN,
      end: at + 7 * MIN,
      exercise: ACTIVE_BREAK_EXERCISES[0]!.id,
    });
    expect(taken.state).toMatchObject({ pending: null, workSince: at + 7 * MIN, quietUntil: null });
    // (The pulses go on while the break is marked.)
    expect(run({ ...taken.state, lastTickAt: at + 7 * MIN }, at + 7.5 * MIN, at + 67.5 * MIN).prompts).toEqual([at + 67 * MIN]);

    const later = answerBreak(state, at, 'postponed', at + MIN, 5);
    expect(later.doc).toMatchObject({ status: 'postponed', start: at + MIN, end: at + MIN });
    expect(later.state.quietUntil).toBe(at + MIN + BREAK_SNOOZE_MS);
    expect(run(later.state, at + 1.5 * MIN, at + 11 * MIN).prompts).toEqual([at + 11 * MIN]);

    expect(answerBreak(state, at - 1, 'taken', at, 5).doc).toBeNull();
    expect(answerBreak(taken.state, at, 'taken', at, 5).doc).toBeNull();
  });

  it('a break marked right away runs from the reminder on', () => {
    const prompt = { at: T0, sessionId: 's1', exercise: 'cuello' };
    expect(breakDoc('u1', prompt, 'taken', T0 + 1000, 5)).toMatchObject({ start: T0, end: T0 + 5 * MIN });
    expect(breakDoc('u1', prompt, 'skipped', T0 + 1000, 5)).toMatchObject({ start: T0 + 1000, end: T0 + 1000 });
  });

  it('helpers: next reminder, texts, ids and storage', () => {
    const { state } = run(null, T0, T0 + 10 * MIN);
    expect(nextBreakAt(state, SETTINGS)).toBe(T0 + 60 * MIN);
    expect(nextBreakAt(null, SETTINGS)).toBeNull();
    expect(breakText({ at: 1, sessionId: 's', exercise: 'vista' }, 5)).toEqual({
      title: 'Pausa activa · 5 min',
      message: 'Descansa la vista (20-20-20). Mira algo a unos 6 metros durante 20 segundos y parpadea varias veces. Repite 3 veces.',
    });
    expect(parseBreakNotificationId(`tt-break:${T0}`)).toBe(T0);
    expect(parseBreakNotificationId('tt-reminder:start:2026-10-05')).toBeNull();
    expect(breakStateFromJSON(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(breakStateFromJSON({ uid: '' })).toBeNull();
    expect(breakStateFromJSON({ uid: 'u1', pending: { at: 'x' } })).toEqual(emptyBreakState('u1'));
    expect(isPopupRequest({ type: 'breaks.answer', answer: 'taken' })).toBe(true);
    expect(isPopupRequest({ type: 'breaks.answer', answer: 'skipped' })).toBe(false);
    expect(isPopupRequest({ type: 'breaks.setEnabled', enabled: 'no' })).toBe(false);
  });
});

describe('active breaks, x times a day (pure)', () => {
  const DAILY: ActiveBreakSettings = { ...SETTINGS, mode: 'daily', perDay: 3 };
  const at = (time: string) => zonedDateTimeToMs('2026-10-05', time);
  // 09:00–13:00 and 14:00–18:00: targets 11:00, 14:00 and 16:00.
  const WINDOWS = [
    { start: at('09:00'), end: at('13:00') },
    { start: at('14:00'), end: at('18:00') },
  ];
  const lunch = (t: number) => (t >= at('13:00') && t < at('14:00') ? { measuring: false } : {});
  const daily = (over: (t: number) => Partial<BreakTickInput> = () => ({})) => (t: number) => ({
    settings: DAILY,
    windows: WINDOWS,
    ...lunch(t),
    ...over(t),
  });

  it('reminds at the targets spread over the schedule, whatever the continuous work', () => {
    const { state, prompts } = run(null, at('09:00'), at('18:00'), daily());
    expect(prompts).toEqual([at('11:00'), at('14:00'), at('16:00')]);
    expect(nextBreakAt(state, DAILY, WINDOWS)).toBeNull();
    expect(nextBreakAt(run(null, at('09:00'), at('11:30'), daily()).state, DAILY, WINDOWS)).toBe(at('14:00'));
  });

  it('drops the targets passed with the work day closed or away for a break, late ones keep a gap', () => {
    // Work day opened at 15:00: the 11:00 and 14:00 targets are dropped.
    const late = (t: number) => (t < at('15:00') ? { sessionId: null } : {});
    expect(run(null, at('09:00'), at('18:00'), daily(late)).prompts).toEqual([at('16:00')]);
    // Away 10:58–11:05 (7 min ≥ 5): it was a break.
    const away = (t: number) => (t >= at('10:58') && t < at('11:05') ? { idle: 'idle' as const } : {});
    expect(run(null, at('09:00'), at('13:00'), daily(away)).prompts).toEqual([]);
    // Away 10:58–11:02 (4 min): the reminder comes back with the person.
    const short = (t: number) => (t >= at('10:58') && t < at('11:02') ? { idle: 'idle' as const } : {});
    expect(run(null, at('09:00'), at('13:00'), daily(short)).prompts).toEqual([at('11:02')]);
    // In a meeting 15:40–16:20: right after it; the next target is not sooner than 30 min.
    const four = { ...DAILY, perDay: 4 }; // 10:36, 12:12, 14:48, 16:24
    const meeting = (t: number) => (t >= at('14:40') && t < at('16:20') ? { inMeeting: true } : {});
    const r = run(null, at('09:00'), at('18:00'), daily((t) => ({ settings: four, ...meeting(t) })));
    expect(r.prompts).toEqual([at('10:36'), at('12:12'), at('16:20'), at('16:20') + DAILY_MIN_GAP_MS]);
  });

  it('windows: the schedule of today without lunch; without a schedule, 9 h from the start of the work day', () => {
    const day = { start: '09:00', end: '18:00', lunchStart: '13:00', lunchEnd: '14:00' };
    const schedule: EffectiveSchedule = {
      week: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null },
      holidays: [],
      toleranceMinutes: 10,
      remindersEnabled: false,
    };
    expect(breakWindows(schedule, at('10:00'), null)).toEqual(WINDOWS);
    expect(breakWindows(null, at('10:00'), at('08:30'))).toEqual([{ start: at('08:30'), end: at('08:30') + NO_SCHEDULE_BREAK_DAY_MS }]);
    expect(breakWindows(null, at('10:00'), null)).toEqual([]);
  });

  it('the exercise follows the plan of the day: the same for everyone, by date and reminder', () => {
    const r = run(null, at('09:00'), at('18:00'), daily());
    expect(r.prompts).toEqual([at('11:00'), at('14:00'), at('16:00')]);
    // Another person (fresh state, another rotation count) gets the same exercises.
    const other = run({ ...emptyBreakState('u1'), shown: 5 }, at('09:00'), at('11:00'), daily()).state.pending;
    expect(other?.exercise).toBe(dailyExercise('2026-10-05', 0, 3).id);
    const exercises: string[] = [];
    let s: BreakState | null = null;
    for (let t = at('09:00'); t <= at('18:00'); t += 30_000) {
      const x = breakTick(s, input(t, daily()(t)));
      s = x.state;
      if (x.prompt) exercises.push(x.prompt.exercise);
    }
    expect(exercises).toEqual([0, 1, 2].map((i) => dailyExercise('2026-10-05', i, 3).id));
    expect(new Set(exercises).size).toBe(3);
  });

  it('"En 10 min" brings the reminder back after the snooze', () => {
    const { state } = run(null, at('09:00'), at('11:00'), daily());
    const later = answerBreak(state, at('11:00'), 'postponed', at('11:01'), 5);
    expect(run(later.state, at('11:01') + 30_000, at('11:20'), daily()).prompts).toEqual([at('11:11')]);
    const taken = answerBreak(state, at('11:00'), 'taken', at('11:01'), 5);
    expect(run(taken.state, at('11:01') + 30_000, at('13:00'), daily()).prompts).toEqual([]);
  });
});

describe('active breaks (extension)', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    h = await createHarness();
    h.backend.org = { ...ORG, activeBreaksEnabled: true, activeBreakIntervalMinutes: 45, activeBreakMinutes: 3 };
    await h.app.refreshOrgConfig(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function pulsesUntil(end: number): Promise<void> {
    while (Date.now() < end) {
      await vi.advanceTimersByTimeAsync(Math.min(30_000, end - Date.now()));
      if (h.chrome.world.alarms.has(PULSE_ALARM)) await h.app.pulse();
      await h.settle();
    }
  }

  const breakNotifications = () => h.chrome.world.notificationLog.filter((n) => n.id.startsWith('tt-break:'));

  it('shows the reminder after the interval and uploads "Tomé la pausa" as a break of the configured duration', async () => {
    await h.app.session.start();
    await pulsesUntil(T0 + 44 * MIN);
    expect(breakNotifications()).toEqual([]);
    expect((await h.app.status()).breaks).toMatchObject({ intervalMinutes: 45, durationMinutes: 3, enabled: true, pending: null });
    await pulsesUntil(T0 + 46 * MIN);
    const [shown] = breakNotifications();
    expect(shown!.options).toMatchObject({
      title: 'Pausa activa · 3 min',
      buttons: [{ title: 'Tomé la pausa' }, { title: 'En 10 min' }],
      requireInteraction: true,
    });
    const promptAt = parseBreakNotificationId(shown!.id)!;
    expect((await h.app.status()).breaks?.pending).toMatchObject({ at: promptAt, title: 'Estira el cuello' });

    vi.setSystemTime(promptAt + 4 * MIN);
    for (const l of h.chrome.events.notificationButton.listeners) l(shown!.id, 0);
    await h.settle();
    expect(h.chrome.world.notifications.has(shown!.id)).toBe(false);
    const sessionId = h.app.store.session!.id;
    expect([...h.backend.breaks.entries()]).toEqual([
      [
        `u1_${promptAt}`,
        {
          uid: 'u1',
          sessionId,
          status: 'taken',
          promptedAt: promptAt,
          answeredAt: promptAt + 4 * MIN,
          start: promptAt + MIN,
          end: promptAt + 4 * MIN,
          exercise: 'cuello',
        },
      ],
    ]);
    expect((await h.app.status()).breaks?.pending).toBeNull();
  });

  it('"En 10 min" and closing the notification are recorded too; turned off by the person, no reminders', async () => {
    await h.app.session.start();
    // The count starts at the first pulse (09:00:30): reminder at 09:45:30.
    await pulsesUntil(T0 + 46 * MIN);
    const first = breakNotifications()[0]!;
    expect(parseBreakNotificationId(first.id)).toBe(T0 + 45.5 * MIN);
    await h.app.handlePopup({ type: 'breaks.answer', answer: 'postponed' });
    expect(h.chrome.world.notifications.has(first.id)).toBe(false);
    await pulsesUntil(T0 + 55.5 * MIN);
    expect(breakNotifications()).toHaveLength(1);
    await pulsesUntil(T0 + 56 * MIN);
    const second = breakNotifications()[1]!;
    expect(parseBreakNotificationId(second.id)).toBe(T0 + 56 * MIN);
    for (const l of h.chrome.events.notificationClosed.listeners) l(second.id, true);
    await h.settle();
    expect([...h.backend.breaks.values()].map((b) => [b.promptedAt, b.status])).toEqual([
      [T0 + 45.5 * MIN, 'postponed'],
      [T0 + 56 * MIN, 'skipped'],
    ]);

    const res = await h.app.handlePopup({ type: 'breaks.setEnabled', enabled: false });
    expect(res.ok && res.status.breaks).toMatchObject({ enabled: false, nextAt: null });
    await pulsesUntil(T0 + 200 * MIN);
    expect(breakNotifications()).toHaveLength(2);
  });

  it('off in config/org: nothing, and no section in the popup', async () => {
    h.backend.org = { ...ORG };
    await h.app.refreshOrgConfig(0);
    await h.app.session.start();
    await pulsesUntil(T0 + 120 * MIN);
    expect(breakNotifications()).toEqual([]);
    expect((await h.app.status()).breaks).toBeNull();
  });
});
