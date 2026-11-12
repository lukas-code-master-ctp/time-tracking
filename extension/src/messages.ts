/**
 * Typed messages between the extension parts (chrome.runtime messaging).
 *
 * content script → service worker (fire and forget, no response):
 *   { type: 'hello' }             page loaded: this tab is measurable
 *   { type: 'activity', t }       keyboard/mouse input seen at `t` (max 1/s)
 *
 * popup / consent page → service worker (request/response):
 *   see {@link PopupRequest}; every request answers {@link PopupResponse}.
 */
import {
  isMoodScore,
  type AttendanceMode,
  type Absence,
  type AbsenceType,
  type Role,
  type UpcomingCelebration,
  type UserStatus,
  type WithId,
} from '@timetracking/shared';
import type { ScheduleView } from './background/schedule';

// ---------- content script ----------

export type ContentMessage = { type: 'hello' } | { type: 'activity'; t: number };

export function isContentMessage(msg: unknown): msg is ContentMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; t?: unknown };
  if (m.type === 'hello') return true;
  return m.type === 'activity' && typeof m.t === 'number' && Number.isFinite(m.t);
}

// ---------- popup ----------

export type PopupRequest =
  | { type: 'status' }
  | { type: 'session.start' }
  /** `mood`: the face chosen next to "Cerrar jornada" (mood pulse, 1–5), sent with the close. */
  | { type: 'session.stop'; mood?: number }
  /** Dev build only: fake Google credential accepted by the Auth emulator. */
  | { type: 'auth.devSignIn'; email: string }
  /** Google login with chrome.identity (prod). */
  | { type: 'auth.signIn' }
  | { type: 'auth.signOut' }
  /** The popup showed the last sign-in result (`at` of {@link SignInResult}): forget it. */
  | { type: 'auth.clearSignInResult'; at: number }
  /** Calls `joinOrg` again (e.g. after the admin sent the invitation). */
  | { type: 'auth.refreshProfile' }
  /** Consent page: accept the transparency notice of `version`. */
  | { type: 'consent.accept'; version: string }
  /** Try to upload the pending queue now. */
  | { type: 'sync.now' }
  /** Answer the pending active break reminder ("Tomé la pausa" / "En 10 min"). */
  | { type: 'breaks.answer'; answer: 'taken' | 'postponed' }
  /** Turn the active break reminders on/off for the signed-in user on this device. */
  | { type: 'breaks.setEnabled'; enabled: boolean }
  /** Mood pulse after closing the work day: a face 1–5, or null = "Omitir". */
  | { type: 'mood.answer'; score: number | null }
  /** Absences page (spec 2026-10-22-solicitud-ausencias): the person's absences and requests. */
  | { type: 'absences.list' }
  /** Request an absence (pending until an admin decides). */
  | { type: 'absences.request'; absence: AbsenceRequest }
  /** Withdraw a pending request. */
  | { type: 'absences.cancel'; id: string }
  /** "Confirmo que lo leí" of an internal announcement (spec 2026-11-05-comunicados). */
  | { type: 'announcements.ack'; id: string }
  /** Dev build only (e2e): run the 30-second pulse now. */
  | { type: 'debug.forcePulse' }
  /** Dev build only (e2e): refresh config/org and take this block's screenshot now. */
  | { type: 'debug.forceScreenshot' };

export type PopupRequestType = PopupRequest['type'];

const POPUP_TYPES: readonly PopupRequestType[] = [
  'status',
  'session.start',
  'session.stop',
  'auth.signIn',
  'auth.signOut',
  'auth.clearSignInResult',
  'auth.refreshProfile',
  'consent.accept',
  'sync.now',
  'breaks.answer',
  'breaks.setEnabled',
  'mood.answer',
  'absences.list',
  'absences.request',
  'absences.cancel',
  'announcements.ack',
  // Dropped from the prod bundle (`__APP_ENV__` is replaced literally).
  ...(__APP_ENV__ === 'dev' ? (['auth.devSignIn', 'debug.forcePulse', 'debug.forceScreenshot'] as const) : []),
];

export function isPopupRequest(msg: unknown): msg is PopupRequest {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; email?: unknown; version?: unknown };
  if (!POPUP_TYPES.includes(m.type as PopupRequestType)) return false;
  if (__APP_ENV__ === 'dev' && m.type === 'auth.devSignIn') return typeof m.email === 'string';
  if (m.type === 'consent.accept') return typeof m.version === 'string';
  if (m.type === 'auth.clearSignInResult') return typeof (msg as { at?: unknown }).at === 'number';
  if (m.type === 'breaks.answer') {
    const answer = (msg as { answer?: unknown }).answer;
    return answer === 'taken' || answer === 'postponed';
  }
  if (m.type === 'breaks.setEnabled') return typeof (msg as { enabled?: unknown }).enabled === 'boolean';
  if (m.type === 'session.stop') {
    const mood = (msg as { mood?: unknown }).mood;
    return mood === undefined || isMoodScore(mood);
  }
  if (m.type === 'mood.answer') {
    const score = (msg as { score?: unknown }).score;
    return score === null || isMoodScore(score);
  }
  if (m.type === 'absences.cancel' || m.type === 'announcements.ack') {
    const id = (msg as { id?: unknown }).id;
    return typeof id === 'string' && id !== '';
  }
  if (m.type === 'absences.request') {
    const a = (msg as { absence?: unknown }).absence;
    return !!a && typeof a === 'object'; // the fields are validated by the worker (validateAbsence)
  }
  return true;
}

/** What the person fills in "Solicitar ausencia" (the worker adds the rest of the document). */
export interface AbsenceRequest {
  type: AbsenceType;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  note: string;
}

/**
 * Outcome of the last "Iniciar sesión con Google" attempt, kept in
 * chrome.storage.session by the service worker: outside Chrome the popup
 * closes when Google's window opens, so it shows this when reopened. Removed
 * when a new attempt starts, when the popup shows it and on sign-out.
 */
export interface SignInResult {
  /** When the attempt ended (ms); identifies it for `auth.clearSignInResult`. */
  at: number;
  ok: boolean;
  /** Spanish message for the popup (error, or who signed in). Never a token. */
  message: string;
}

export interface StatusView {
  appEnv: 'dev' | 'prod';
  /** Firebase user of the extension, or null when signed out. */
  user: { uid: string; email: string | null; displayName: string | null } | null;
  /** `users/{uid}` returned by joinOrg; null until joined. */
  profile: { email: string; displayName: string; role: Role; status: UserStatus } | null;
  /** Why joinOrg rejected the user (`details.reason` of the HttpsError). */
  joinError: { reason: string; message: string } | null;
  /** The profile has not accepted the current notice (`CONSENT_VERSION`). */
  consentRequired: boolean;
  /** Version the consent page accepts. */
  consentVersion: string;
  /**
   * Open work day, if any. `startedAt`: start of the work day (the first
   * session when it continued after a sleep). `pauses`: what the popup clock
   * leaves out: gaps while the computer slept or Chrome was closed, and the
   * lunches of the schedule (`config/org.pauseTimerAtLunch`); they may overlap.
   */
  /** `kiosk`: joined from an entry marked on the kiosk (spec 2026-11-10-marcaciones). */
  session: { id: string; startedAt: number; pauses: { start: number; end: number }[]; kiosk: boolean } | null;
  /** Today's totals (America/Santiago) from the blocks measured on this device. */
  today: { trackedSeconds: number; activeSeconds: number; meetingSeconds: number };
  /** What is measured, from the cached `config/org` (null = not read yet). */
  capture: { screenshots: boolean; blur: boolean } | null;
  /** Working hours now and today (spec 2026-09-30-horarios); null = no schedule (nothing new is shown). */
  schedule: ScheduleView | null;
  /**
   * Active breaks (spec 2026-10-21-pausa-activa); null = the organization has
   * them off. `enabled`: the person did not turn them off on this device.
   * `pending`: reminder waiting for an answer. `nextAt`: estimate of the next
   * reminder (null when not counting: no work day, away, lunch…).
   */
  breaks: {
    /** `interval`: after `intervalMinutes` of continuous work; `daily`: `perDay` a day; `times`: at `times`. */
    mode: 'interval' | 'daily' | 'times';
    intervalMinutes: number;
    perDay: number;
    /** `times` mode: "HH:MM", sorted. */
    times: string[];
    durationMinutes: number;
    enabled: boolean;
    /** `exercise`: id in the library (draws its animation; null when unknown to this version). */
    pending: { at: number; title: string; text: string; exercise: string | null } | null;
    nextAt: number | null;
  } | null;
  /**
   * Internal announcements the person has not confirmed yet, oldest first
   * (spec 2026-11-05-comunicados); [] when there are none or before joining.
   */
  announcements: { id: string; title: string; body: string; authorName: string; createdAt: number }[];
  /**
   * Team birthdays and work anniversaries of today and the next 7 days
   * (spec 2026-11-05-cumpleanos-aniversarios), soonest first; `self`: the
   * signed-in person's own; `managed`: the signed-in person is their boss
   * (the popup warns them the day before). [] when none or not read yet.
   */
  celebrations: (UpcomingCelebration & { self: boolean; managed: boolean })[];
  /**
   * Mood pulse (spec 2026-11-05-pulso-de-animo); null = the organization has
   * it off. `pending`: the person closed today's work day and has not answered
   * "¿Cómo estuvo tu día?" nor skipped it.
   */
  mood: {
    pending: boolean;
    /** Already answered or skipped today: the faces next to "Cerrar jornada" are not shown. */
    doneToday: boolean;
  } | null;
  /**
   * How the person marks attendance (spec 2026-11-10-marcaciones), from the
   * last read; `kiosk`: on the kiosk at the entrance only (no "Iniciar
   * jornada" in the popup). null = not read yet (as `extension`).
   */
  attendanceMode: AttendanceMode | null;
  /** Operations waiting to be uploaded. */
  pendingOps: number;
  /** Screenshots waiting to be uploaded. */
  pendingScreenshots: number;
  lastSyncOkAt: number | null;
  /** Last user-facing problem (Spanish), e.g. session closed automatically. */
  notice: string | null;
  /** Result of the last sign-in attempt not shown yet by the popup. */
  signInResult: SignInResult | null;
}

export type PopupResponse =
  | { ok: true; status: StatusView; debug?: unknown; absences?: WithId<Absence>[] }
  | { ok: false; error: string; reason?: string; status?: StatusView };
