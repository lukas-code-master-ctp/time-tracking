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
import type { Role, UserStatus } from '@timetracking/shared';
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
  | { type: 'session.stop' }
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
  return true;
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
   * Open work day, if any. `pauses`: lunches of the schedule the popup clock
   * leaves out (`config/org.pauseTimerAtLunch`); [] = the clock never stops.
   */
  session: { id: string; startedAt: number; pauses: { start: number; end: number }[] } | null;
  /** Today's totals (America/Santiago) from the blocks measured on this device. */
  today: { trackedSeconds: number; activeSeconds: number; meetingSeconds: number };
  /** What is measured, from the cached `config/org` (null = not read yet). */
  capture: { screenshots: boolean; blur: boolean } | null;
  /** Working hours now and today (spec 2026-09-30-horarios); null = no schedule (nothing new is shown). */
  schedule: ScheduleView | null;
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
  | { ok: true; status: StatusView; debug?: unknown }
  | { ok: false; error: string; reason?: string; status?: StatusView };
