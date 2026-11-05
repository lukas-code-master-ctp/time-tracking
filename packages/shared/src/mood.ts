/**
 * "Pulso de ánimo" (spec 2026-11-05-pulso-de-animo.md): when a person closes
 * the work day, the extension asks "¿Cómo estuvo tu día?" with five faces.
 * Pure.
 *
 * Anonymous by design: no document links a person to an answer.
 * - `moodWeeks/{YYYY-Www}` holds only counters (`n1`..`n5`) of the ISO week,
 *   incremented by one per answer. Admins read them.
 * - `moodVotes/{uid_YYYY-Www}` only says which days of the week the person
 *   already answered (`dates`), never what. Only the person reads it; it lets
 *   the rules accept one answer per person and day (the counter may grow only
 *   in the same write that adds a date to it).
 * The portal hides weeks with fewer than {@link MOOD_MIN_RESPONSES} answers.
 */

import { isValidDateKey } from './schedule.js';

export type MoodScore = 1 | 2 | 3 | 4 | 5;

export const MOOD_SCORES: readonly MoodScore[] = Object.freeze([1, 2, 3, 4, 5]);

export interface MoodOption {
  score: MoodScore;
  emoji: string;
  label: string;
}

/** From worst to best, as the popup shows them. */
export const MOOD_OPTIONS: readonly MoodOption[] = Object.freeze([
  { score: 1, emoji: '😣', label: 'Muy mal' },
  { score: 2, emoji: '😕', label: 'Mal' },
  { score: 3, emoji: '😐', label: 'Normal' },
  { score: 4, emoji: '🙂', label: 'Bien' },
  { score: 5, emoji: '😄', label: 'Muy bien' },
]);

/** Weeks with fewer answers are not shown in the portal (someone could be identified). */
export const MOOD_MIN_RESPONSES = 3;

/** Counter field of a score in `moodWeeks/{week}`. */
export type MoodCountKey = 'n1' | 'n2' | 'n3' | 'n4' | 'n5';

/** `moodWeeks/{YYYY-Www}`: answers per score; a missing field is 0. */
export type MoodWeek = Partial<Record<MoodCountKey, number>>;

/** `moodVotes/{uid_YYYY-Www}`: the days of that week the person already answered. */
export interface MoodVote {
  uid: string;
  week: string;
  /** `YYYY-MM-DD` (America/Santiago), at most 7. */
  dates: string[];
}

export function isMoodScore(v: unknown): v is MoodScore {
  return typeof v === 'number' && MOOD_SCORES.includes(v as MoodScore);
}

export function moodCountKey(score: MoodScore): MoodCountKey {
  return `n${score}` as MoodCountKey;
}

export function moodOption(score: MoodScore): MoodOption {
  return MOOD_OPTIONS[score - 1]!;
}

const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

export function isValidWeekKey(week: string): boolean {
  return WEEK_RE.test(week);
}

/** ISO 8601 week of a calendar date: `2026-11-05` → `2026-W45`. */
export function isoWeekKey(date: string): string {
  if (!isValidDateKey(date)) throw new Error(`isoWeekKey: invalid date ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7; // Monday 1 … Sunday 7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday of the same week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday (`YYYY-MM-DD`) of an ISO week. */
export function weekMonday(week: string): string {
  const match = WEEK_RE.exec(week);
  if (!match) throw new Error(`weekMonday: invalid week ${week}`);
  const year = Number(match[1]);
  const n = Number(match[2]);
  // The 4th of January is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000 + (n - 1) * 7 * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` plus `days` (may be negative). */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The `count` ISO weeks ending with the week of `date`, oldest first. */
export function lastWeeks(date: string, count: number): string[] {
  const monday = weekMonday(isoWeekKey(date));
  return Array.from({ length: count }, (_, i) => isoWeekKey(addDays(monday, -7 * (count - 1 - i))));
}

/** Id of `moodVotes`: `uid_YYYY-Www`. */
export function moodVoteDocId(uid: string, week: string): string {
  if (!uid) throw new Error('moodVoteDocId: uid is required');
  if (!isValidWeekKey(week)) throw new Error(`moodVoteDocId: invalid week ${week}`);
  return `${uid}_${week}`;
}

export interface MoodSummary {
  /** Answers per score, index 0 = score 1. */
  counts: [number, number, number, number, number];
  total: number;
  /** 1–5, null without answers. */
  average: number | null;
  /** Below {@link MOOD_MIN_RESPONSES}: the portal hides the numbers. */
  hidden: boolean;
}

/** Counters of a week (tolerates missing or invalid fields as 0). */
export function summarizeMood(week: unknown): MoodSummary {
  const w = (week && typeof week === 'object' ? week : {}) as Record<string, unknown>;
  const counts = MOOD_SCORES.map((s) => {
    const v = w[moodCountKey(s)];
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0;
  }) as MoodSummary['counts'];
  const total = counts.reduce((a, b) => a + b, 0);
  const sum = counts.reduce((acc, c, i) => acc + c * (i + 1), 0);
  return { counts, total, average: total > 0 ? sum / total : null, hidden: total < MOOD_MIN_RESPONSES };
}

/** Sum of several weeks (e.g. the last 4), same shape as {@link summarizeMood}. */
export function mergeMood(summaries: readonly MoodSummary[]): MoodSummary {
  const counts = [0, 0, 0, 0, 0] as MoodSummary['counts'];
  for (const s of summaries) s.counts.forEach((c, i) => (counts[i] = (counts[i] ?? 0) + c));
  const week: MoodWeek = {};
  MOOD_SCORES.forEach((s, i) => (week[moodCountKey(s)] = counts[i]));
  return summarizeMood(week);
}

/** The option closest to an average (for its face). */
export function moodOfAverage(average: number): MoodOption {
  const score = Math.min(5, Math.max(1, Math.round(average))) as MoodScore;
  return moodOption(score);
}

/** `config/org.moodPulseEnabled`: missing or not `true` = off. */
export function readMoodPulseEnabled(config: unknown): boolean {
  return !!config && typeof config === 'object' && (config as { moodPulseEnabled?: unknown }).moodPulseEnabled === true;
}
