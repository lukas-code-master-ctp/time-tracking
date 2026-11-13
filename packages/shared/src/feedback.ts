/**
 * "Comentarios anónimos" (spec 2026-11-13-comentarios-anonimos): a person
 * leaves a short note about something that happened in their day, good or
 * bad, from the extension popup; the admins read it in the portal. Pure.
 *
 * Anonymous by design, like the mood pulse (mood.ts):
 * - `feedback/{autoId}` holds only `{ week, tone, text }`: no uid, no day, no
 *   time. The id is random, so the order tells nothing either. Admins read it.
 * - `feedbackVotes/{uid_YYYY-Www}` only says which days of the week the person
 *   already left a comment (`dates`), never which. Only the person reads it;
 *   the rules accept a comment only in the same write that adds a new day to
 *   it (one comment per person and day).
 */

import { isValidWeekKey } from './mood.js';

export type FeedbackTone = 'positive' | 'negative';

export const FEEDBACK_TONES: readonly FeedbackTone[] = Object.freeze(['positive', 'negative']);

export const FEEDBACK_TONE_LABEL: Readonly<Record<FeedbackTone, string>> = Object.freeze({
  positive: 'Algo bueno',
  negative: 'Algo por mejorar',
});

export const FEEDBACK_TONE_EMOJI: Readonly<Record<FeedbackTone, string>> = Object.freeze({
  positive: '👍',
  negative: '👎',
});

/** Characters of a comment (also checked by the rules). */
export const FEEDBACK_MAX_LENGTH = 500;

/** `feedback/{autoId}` */
export interface Feedback {
  /** ISO week `YYYY-Www` (America/Santiago) of the day it was written. */
  week: string;
  tone: FeedbackTone;
  /** 1–{@link FEEDBACK_MAX_LENGTH} characters, trimmed. */
  text: string;
}

/** `feedbackVotes/{uid_YYYY-Www}`: the days of that week the person already left a comment. */
export interface FeedbackVote {
  uid: string;
  week: string;
  /** `YYYY-MM-DD` (America/Santiago), at most 7. */
  dates: string[];
}

export function isFeedbackTone(v: unknown): v is FeedbackTone {
  return v === 'positive' || v === 'negative';
}

/** Trims and collapses runs of blank lines; null when empty or too long. */
export function normalizeFeedbackText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > 0 && t.length <= FEEDBACK_MAX_LENGTH ? t : null;
}

/** Id of `feedbackVotes`: `uid_YYYY-Www`. */
export function feedbackVoteDocId(uid: string, week: string): string {
  if (!uid) throw new Error('feedbackVoteDocId: uid is required');
  if (!isValidWeekKey(week)) throw new Error(`feedbackVoteDocId: invalid week ${week}`);
  return `${uid}_${week}`;
}

/** A valid `feedback` document (the portal skips the rest). */
export function isFeedback(v: unknown): v is Feedback {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.week === 'string' &&
    isValidWeekKey(f.week) &&
    isFeedbackTone(f.tone) &&
    typeof f.text === 'string' &&
    f.text.length > 0 &&
    f.text.length <= FEEDBACK_MAX_LENGTH
  );
}

/** `config/org.feedbackEnabled`: missing or not `true` = off. */
export function readFeedbackEnabled(config: unknown): boolean {
  return !!config && typeof config === 'object' && (config as { feedbackEnabled?: unknown }).feedbackEnabled === true;
}
