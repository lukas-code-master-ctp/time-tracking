/**
 * "Minuta diaria" (spec 2026-11-13-minuta-diaria.md): people in the groups the
 * organization picks (e.g. "Terreno") are reminded, when they close the work
 * day, to send a short report of their day. They write it or record an audio
 * that the Cloud Function `draftDailyReport` transcribes and turns into a
 * draft with AI (OpenRouter); the person reviews it and sends it. Pure.
 */

import type { Absence, EpochMs, OrgConfig, UserProfile, WeekSchedule } from './types.js';
import { isValidDateKey, planForDay } from './schedule.js';
import { absenceCoversDate, absenceStatus, isFullDayAbsence } from './absences.js';

/** Characters of the report the person sends. */
export const DAILY_REPORT_MAX_CHARS = 4000;

/** Characters of the AI transcript kept next to the report. */
export const DAILY_REPORT_TRANSCRIPT_MAX_CHARS = 20000;

/** Groups the organization can ask for a daily report. */
export const DAILY_REPORT_MAX_GROUPS = 20;

/**
 * Longest audio the extension records (seconds). The page records mono WAV
 * at {@link DAILY_REPORT_AUDIO_SAMPLE_RATE} Hz (16-bit): every model behind
 * OpenRouter reads WAV, and 4 minutes stay under the callable size limit.
 */
export const DAILY_REPORT_MAX_AUDIO_SECONDS = 4 * 60;

/** Sample rate of the recording (Hz): enough for speech. */
export const DAILY_REPORT_AUDIO_SAMPLE_RATE = 12_000;

/** Largest audio `draftDailyReport` accepts (bytes, before base64). */
export const DAILY_REPORT_MAX_AUDIO_BYTES = 7 * 1024 * 1024;

/** AI drafts a person may ask for per day (cost guard, counted by the function). */
export const DAILY_REPORT_MAX_DRAFTS_PER_DAY = 10;

/** Audio types `draftDailyReport` accepts, with the OpenRouter `input_audio.format` of each. */
export const DAILY_REPORT_AUDIO_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
});

/** Base mime type (`audio/wav;x=y` → `audio/wav`) when accepted, else null. */
export function dailyReportAudioType(mime: unknown): string | null {
  if (typeof mime !== 'string') return null;
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return base in DAILY_REPORT_AUDIO_FORMATS ? base : null;
}

export type DailyReportSource = 'text' | 'audio';

/**
 * `dailyReports/{uid_YYYY-MM-DD}`: the report of one person for one day
 * (America/Santiago). Written by the person; she can correct it the same
 * day. Admins read every report.
 */
export interface DailyReport {
  uid: string;
  /** `YYYY-MM-DD`, part of the id. */
  date: string;
  /** What the person sent (written, or the AI draft she reviewed). */
  text: string;
  /** `audio`: the text started as an AI draft of a recording. */
  source: DailyReportSource;
  /** AI transcript of the recording (`source: 'audio'`), otherwise null. The audio itself is never stored. */
  transcript: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

/** `dailyReportDrafts/{uid_YYYY-MM-DD}`: AI drafts used that day (written only by the function). */
export interface DailyReportDraftCount {
  uid: string;
  date: string;
  count: number;
  updatedAt: EpochMs;
}

/** Deterministic id: `uid_YYYY-MM-DD` (one report per person and day). */
export function dailyReportDocId(uid: string, date: string): string {
  if (!uid || uid.includes('/')) throw new Error('dailyReportDocId: invalid uid');
  if (!isValidDateKey(date)) throw new Error(`dailyReportDocId: invalid date ${date}`);
  return `${uid}_${date}`;
}

export interface DailyReportSettings {
  enabled: boolean;
  /** Groups (`groups/{id}`) whose members are asked for the report. */
  groupIds: string[];
}

/** Settings from `config/org` (missing = off, no groups). */
export function readDailyReportSettings(config: Partial<OrgConfig> | null | undefined): DailyReportSettings {
  const ids = Array.isArray(config?.dailyReportGroupIds)
    ? config.dailyReportGroupIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  return { enabled: config?.dailyReportEnabled === true, groupIds: [...new Set(ids)].slice(0, DAILY_REPORT_MAX_GROUPS) };
}

/** True for a person marked "Terreno" in the portal (missing = office). */
export function isFieldWorker(profile: Pick<UserProfile, 'workplace'> | null | undefined): boolean {
  return profile?.workplace === 'field';
}

/**
 * True when a person must send the report: the report is on and she works in
 * the field, or she is in one of the chosen groups (`memberOf`: ids of her groups).
 */
export function requiresDailyReport(
  settings: DailyReportSettings,
  memberOf: readonly string[],
  profile?: Pick<UserProfile, 'workplace'> | null,
): boolean {
  return settings.enabled && (isFieldWorker(profile) || settings.groupIds.some((id) => memberOf.includes(id)));
}

export type DailyReportIssue = 'uid' | 'date' | 'text' | 'source' | 'transcript' | 'times';

/** What is wrong with a report (empty = valid). Mirrors firestore.rules. */
export function validateDailyReport(r: Partial<DailyReport>): DailyReportIssue[] {
  const issues: DailyReportIssue[] = [];
  if (typeof r.uid !== 'string' || r.uid === '') issues.push('uid');
  if (typeof r.date !== 'string' || !isValidDateKey(r.date)) issues.push('date');
  if (typeof r.text !== 'string' || r.text.trim() === '' || r.text.length > DAILY_REPORT_MAX_CHARS) issues.push('text');
  if (r.source !== 'text' && r.source !== 'audio') issues.push('source');
  const t = r.transcript;
  if (!(t === null || (typeof t === 'string' && t.length <= DAILY_REPORT_TRANSCRIPT_MAX_CHARS))) issues.push('transcript');
  else if (r.source === 'text' && t !== null) issues.push('transcript');
  const okTime = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (!okTime(r.createdAt) || !okTime(r.updatedAt) || (r.updatedAt as number) < (r.createdAt as number)) issues.push('times');
  return issues;
}

/**
 * Instructions for the model: transcribe the audio and write the report in
 * Spanish (Chile), first person, without inventing anything.
 */
export const DAILY_REPORT_AI_PROMPT = [
  'Eres el asistente de una empresa chilena. El audio es una persona que trabaja en terreno contando cómo estuvo su día de trabajo.',
  '1. Transcribe el audio completo y fielmente en "transcript" (español, con puntuación).',
  '2. Escribe en "minuta" una minuta breve del día en primera persona y en español de Chile, en viñetas que empiecen con "- ".',
  '   Agrupa por: lugares o clientes visitados, trabajo realizado, problemas o pendientes y próximos pasos. Omite los grupos sin información.',
  '   Usa solo lo que dice el audio: no inventes nombres, cifras ni horas. Máximo 15 viñetas.',
  'Si el audio no tiene voz o no se entiende, deja "minuta" vacía.',
].join('\n');

/** JSON schema the model must answer (OpenRouter `response_format`). */
export const DAILY_REPORT_AI_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string' },
    minuta: { type: 'string' },
  },
  required: ['transcript', 'minuta'],
  additionalProperties: false,
} as const;

/** Result of `draftDailyReport`. */
export interface DailyReportDraft {
  transcript: string;
  /** Draft of the report (may be empty when nothing was understood). */
  text: string;
}

/** Parses and trims the model's JSON answer; null when it is not usable. */
export function parseDailyReportDraft(raw: unknown): DailyReportDraft | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    // Some models wrap the JSON in a ```json fence despite the schema.
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const { transcript, minuta } = value as { transcript?: unknown; minuta?: unknown };
  if (typeof transcript !== 'string' || typeof minuta !== 'string') return null;
  return {
    transcript: transcript.trim().slice(0, DAILY_REPORT_TRANSCRIPT_MAX_CHARS),
    text: minuta.trim().slice(0, DAILY_REPORT_MAX_CHARS),
  };
}

/** Valid report read from Firestore, or null. */
export function readDailyReport(raw: unknown): DailyReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<DailyReport>;
  if (validateDailyReport(d).length > 0) return null;
  return {
    uid: d.uid!,
    date: d.date!,
    text: d.text!,
    source: d.source!,
    transcript: d.transcript ?? null,
    createdAt: d.createdAt!,
    updatedAt: d.updatedAt!,
  };
}

// ---------- people in the field (spec 2026-11-13-minuta-terreno) ----------

/**
 * Portal page where people without a computer (in the field) send the report
 * from their phone: `app.mipegahr.cl/terreno`.
 */
export const DAILY_REPORT_FIELD_PATH = '/terreno';

/**
 * The reminder email goes out after the end of the person's schedule, within
 * this window (a run of the job that was missed still sends it; later than
 * this it is no longer useful).
 */
export const DAILY_REPORT_REMINDER_WINDOW_MS = 3 * 60 * 60 * 1000;

/** `dailyReportReminders/{uid_YYYY-MM-DD}`: the reminder email of that day was sent (only the function writes it). */
export interface DailyReportReminder {
  uid: string;
  date: string;
  sentAt: EpochMs;
}

/**
 * True when the reminder email is due for a person asked for the report:
 * her schedule of `date` ended less than {@link DAILY_REPORT_REMINDER_WINDOW_MS}
 * ago, it is not a day off or a holiday, she has no approved full-day
 * absence that day, and she has not sent the report nor got the reminder.
 */
export function dailyReportReminderDue(p: {
  now: EpochMs;
  date: string;
  week: WeekSchedule | null;
  holidays: readonly string[];
  absences: readonly Pick<Absence, 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'status'>[];
  sent: boolean;
  reminded: boolean;
}): boolean {
  if (p.sent || p.reminded) return false;
  const span = planForDay(p.date, p.week, p.holidays).span;
  if (!span || p.now < span.end || p.now >= span.end + DAILY_REPORT_REMINDER_WINDOW_MS) return false;
  const away = p.absences.some(
    (a) => absenceStatus(a) === 'approved' && isFullDayAbsence(a) && absenceCoversDate(a, p.date),
  );
  return !away;
}
