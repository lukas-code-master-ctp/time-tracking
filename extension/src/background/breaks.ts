/**
 * "Pausa activa" in the extension (spec 2026-10-21-pausa-activa). Pure
 * helpers over the cached settings of `config/org`; the wiring (pulse,
 * notifications, popup, queue) lives in app.ts.
 *
 * - The reminder comes after `intervalMinutes` of continuous work: the work
 *   day open and measured (inside the schedule, not at lunch) with keyboard
 *   or mouse activity. Being away (idle or locked) for `durationMinutes`, or
 *   a gap without pulses that long (computer asleep), already is a break:
 *   the count starts again.
 * - Never during a web meeting nor while the person is away: it waits.
 * - One reminder at a time. Unanswered, the next one comes a full interval
 *   later and replaces it (the old one is recorded as skipped).
 * - Each answer ("Tomé la pausa", "En 10 min", closed) becomes one
 *   `breaks/{uid_promptedAt}` document through the upload queue.
 * - Each person can turn the reminders off for themselves (kept on this
 *   device, per user).
 */
import {
  DEFAULT_TIME_ZONE,
  dailyBreakTargets,
  dailyExercise,
  dateKey,
  exerciseAt,
  exerciseById,
  exerciseInstructions,
  type ActiveBreak,
  type ActiveBreakSettings,
  type ActiveBreakStatus,
  type IdleState,
} from '@timetracking/shared';

/** "En 10 min". */
export const BREAK_SNOOZE_MS = 10 * 60_000;
/** `daily` mode: no reminder sooner than this after the previous one (a late one moves the next). */
export const DAILY_MIN_GAP_MS = 30 * 60_000;

/** Reminder shown and not answered yet. */
export interface BreakPrompt {
  /** When it was shown (id of the notification and of the `breaks` doc). */
  at: number;
  sessionId: string;
  exercise: string;
}

/** `tt.meta.breaks`: state of the active breaks of one user on this device. */
export interface BreakState {
  uid: string;
  /** Start of the current stretch of continuous work; null = not working now. */
  workSince: number | null;
  /** Away (idle/locked) since; null = active. */
  awaySince: number | null;
  /** Last tick with the work day measured (a longer gap than the break resets the count). */
  lastTickAt: number | null;
  /** No reminder before this instant (just shown, or postponed). */
  quietUntil: number | null;
  /** `daily` mode: the targets up to this instant are done (shown or dropped). */
  doneUntil: number | null;
  pending: BreakPrompt | null;
  /** Reminders shown so far (rotates the exercise). */
  shown: number;
}

export function emptyBreakState(uid: string): BreakState {
  return { uid, workSince: null, awaySince: null, lastTickAt: null, quietUntil: null, doneUntil: null, pending: null, shown: 0 };
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Re-validates the state read from `chrome.storage.local` (missing before 0.2.7). */
export function breakStateFromJSON(raw: unknown): BreakState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Record<keyof BreakState, unknown>>;
  if (typeof r.uid !== 'string' || !r.uid) return null;
  const p = r.pending as Partial<BreakPrompt> | null | undefined;
  const pending =
    p && typeof p === 'object' && typeof p.at === 'number' && typeof p.sessionId === 'string' && typeof p.exercise === 'string'
      ? { at: p.at, sessionId: p.sessionId, exercise: p.exercise }
      : null;
  return {
    uid: r.uid,
    workSince: numOrNull(r.workSince),
    awaySince: numOrNull(r.awaySince),
    lastTickAt: numOrNull(r.lastTickAt),
    quietUntil: numOrNull(r.quietUntil),
    doneUntil: numOrNull(r.doneUntil),
    pending,
    shown: typeof r.shown === 'number' && Number.isInteger(r.shown) && r.shown >= 0 ? r.shown : 0,
  };
}

export interface BreakTickInput {
  now: number;
  uid: string;
  settings: ActiveBreakSettings | null;
  /** The person turned the reminders off on this device. */
  optedOut: boolean;
  /** Open work day, or null. */
  sessionId: string | null;
  /** The open work day is measured now (inside the schedule). */
  measuring: boolean;
  idle: IdleState;
  inMeeting: boolean;
  /** `daily` mode: working windows of today (`breakWindows`). */
  windows: readonly { start: number; end: number }[];
}

export interface BreakTickResult {
  state: BreakState;
  /** Reminder to show now. */
  prompt: BreakPrompt | null;
  /** Unanswered reminder replaced by `prompt` (record it as skipped, clear its notification). */
  replaced: BreakPrompt | null;
}

/** Advances the count at `now` (every pulse) and decides whether a reminder is due. */
export function breakTick(prev: BreakState | null, input: BreakTickInput): BreakTickResult {
  const { now, settings } = input;
  const state: BreakState = prev && prev.uid === input.uid ? { ...prev } : emptyBreakState(input.uid);
  const none = { state, prompt: null, replaced: null };
  if (!settings?.enabled || input.optedOut || !input.sessionId || !input.measuring) {
    // Not working (or no reminders): the next stretch starts from zero.
    state.workSince = null;
    state.awaySince = null;
    state.lastTickAt = null;
    state.doneUntil = now;
    return none;
  }
  const daily = settings.mode === 'daily';
  const breakMs = settings.durationMinutes * 60_000;
  const intervalMs = settings.intervalMinutes * 60_000;
  // A break's length without pulses (asleep / closed) or away: it was a break.
  const rested = (): void => {
    state.workSince = null;
    if (daily) state.doneUntil = now;
  };
  if (state.lastTickAt !== null && now - state.lastTickAt >= breakMs) rested();
  state.lastTickAt = now;
  if (!daily || state.doneUntil === null) state.doneUntil = now;
  if (input.idle !== 'active') {
    state.awaySince ??= now;
    if (now - state.awaySince >= breakMs) rested();
    return none;
  }
  if (state.awaySince !== null && now - state.awaySince >= breakMs) rested();
  state.awaySince = null;
  state.workSince ??= now;
  const quiet = state.quietUntil !== null && now < state.quietUntil;
  const targets = daily ? dailyBreakTargets(input.windows, settings.perDay) : [];
  // `daily`: the latest target due (an earlier one passed in a meeting is folded into it).
  let target = -1;
  targets.forEach((t, i) => {
    if (t > state.doneUntil! && t <= now) target = i;
  });
  const due = daily ? target !== -1 : now - state.workSince >= intervalMs;
  if (!due || quiet || input.inMeeting) return none;
  // `daily`: the exercise of the plan of the day (the same for everyone); `interval`: this device's rotation.
  const exercise = daily ? dailyExercise(dateKey(now, DEFAULT_TIME_ZONE), target, settings.perDay) : exerciseAt(state.shown);
  const prompt: BreakPrompt = { at: now, sessionId: input.sessionId, exercise: exercise.id };
  const replaced = state.pending;
  state.pending = prompt;
  state.shown += 1;
  state.doneUntil = now;
  state.quietUntil = now + (daily ? DAILY_MIN_GAP_MS : intervalMs);
  return { state, prompt, replaced };
}

export type BreakAnswer = 'taken' | 'postponed' | 'skipped';

/**
 * The `breaks` document of an answer. `taken`: the break is the configured
 * duration ending when the person says so, but never before the reminder
 * (answered right away, it runs from the reminder on).
 */
export function breakDoc(uid: string, prompt: BreakPrompt, status: ActiveBreakStatus, answeredAt: number, durationMinutes: number): ActiveBreak {
  const at = Math.round(prompt.at);
  const answered = Math.max(at, Math.round(answeredAt));
  const breakMs = durationMinutes * 60_000;
  const start = status === 'taken' ? Math.max(at, answered - breakMs) : answered;
  const end = status === 'taken' ? start + breakMs : answered;
  return { uid, sessionId: prompt.sessionId, status, promptedAt: at, answeredAt: answered, start, end, exercise: prompt.exercise };
}

export interface BreakAnswerResult {
  state: BreakState;
  /** Document to upload; null when `promptAt` is not the pending reminder (already answered or replaced). */
  doc: ActiveBreak | null;
}

/** Applies the answer to the pending reminder shown at `promptAt`. */
export function answerBreak(
  state: BreakState,
  promptAt: number,
  answer: BreakAnswer,
  now: number,
  durationMinutes: number,
): BreakAnswerResult {
  const prompt = state.pending;
  if (!prompt || prompt.at !== promptAt) return { state, doc: null };
  const next: BreakState = { ...state, pending: null };
  if (answer === 'taken') {
    // A new stretch of work starts now.
    next.workSince = now;
    next.awaySince = null;
    next.quietUntil = null;
  } else if (answer === 'postponed') {
    next.quietUntil = now + BREAK_SNOOZE_MS;
    // `daily` mode: the reminder is due again after the snooze.
    next.doneUntil = 0;
  }
  return { state: next, doc: breakDoc(state.uid, prompt, answer, now, durationMinutes) };
}

/** Next reminder (estimate for the popup): null when not counting now or none left today. */
export function nextBreakAt(
  state: BreakState | null,
  settings: ActiveBreakSettings | null,
  windows: readonly { start: number; end: number }[] = [],
): number | null {
  if (!state || !settings?.enabled || state.workSince === null) return null;
  if (settings.mode === 'daily') {
    const done = state.doneUntil ?? 0;
    const next = dailyBreakTargets(windows, settings.perDay).find((t) => t > done);
    return next === undefined ? null : Math.max(next, state.quietUntil ?? 0);
  }
  return Math.max(state.workSince + settings.intervalMinutes * 60_000, state.quietUntil ?? 0);
}

// ---------- notifications ----------

const NOTIFICATION_PREFIX = 'tt-break';

export function breakNotificationId(promptAt: number): string {
  return `${NOTIFICATION_PREFIX}:${promptAt}`;
}

export function parseBreakNotificationId(id: string): number | null {
  const m = /^tt-break:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Buttons of the notification, in order (index of `onButtonClicked`). */
export const BREAK_BUTTONS = ['Tomé la pausa', 'En 10 min'] as const;

export function breakText(prompt: BreakPrompt, durationMinutes: number): { title: string; message: string } {
  const ex = exerciseById(prompt.exercise);
  return {
    title: `Pausa activa · ${durationMinutes} min`,
    message: ex ? `${ex.title}. ${exerciseInstructions(ex, durationMinutes)}` : 'Levántate y estira el cuerpo unos minutos.',
  };
}
