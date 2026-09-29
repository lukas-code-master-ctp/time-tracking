/**
 * Typed messages between the extension parts (chrome.runtime messaging).
 *
 * content script → service worker (fire and forget, no response):
 *   { type: 'hello' }             page loaded: this tab is measurable
 *   { type: 'activity', t }       keyboard/mouse input seen at `t` (max 1/s)
 *
 * popup → service worker (request/response):
 *   see {@link PopupRequest}; every request answers {@link PopupResponse}.
 */
import type { Role, UserStatus } from '@timetracking/shared';

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
  /** Prod login (chrome.identity) — implemented in Task 5. */
  | { type: 'auth.signIn' }
  | { type: 'auth.signOut' }
  /** Calls `joinOrg` again (e.g. after the admin sent the invitation). */
  | { type: 'auth.refreshProfile' }
  /** Try to upload the pending queue now. */
  | { type: 'sync.now' };

export type PopupRequestType = PopupRequest['type'];

const POPUP_TYPES: readonly PopupRequestType[] = [
  'status',
  'session.start',
  'session.stop',
  'auth.devSignIn',
  'auth.signIn',
  'auth.signOut',
  'auth.refreshProfile',
  'sync.now',
];

export function isPopupRequest(msg: unknown): msg is PopupRequest {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type?: unknown; email?: unknown };
  if (!POPUP_TYPES.includes(m.type as PopupRequestType)) return false;
  if (m.type === 'auth.devSignIn') return typeof m.email === 'string';
  return true;
}

export interface StatusView {
  appEnv: 'dev' | 'prod';
  /** Firebase user of the extension, or null when signed out. */
  user: { uid: string; email: string | null; displayName: string | null } | null;
  /** `users/{uid}` returned by joinOrg; null until joined. */
  profile: { email: string; displayName: string; role: Role; status: UserStatus } | null;
  /** Why joinOrg rejected the user (`details.reason` of the HttpsError). */
  joinError: { reason: string; message: string } | null;
  /** Open work day, if any. */
  session: { id: string; startedAt: number } | null;
  /** Operations waiting to be uploaded. */
  pendingOps: number;
  lastSyncOkAt: number | null;
  /** Last user-facing problem (Spanish), e.g. session closed automatically. */
  notice: string | null;
}

export type PopupResponse =
  | { ok: true; status: StatusView }
  | { ok: false; error: string; reason?: string; status?: StatusView };
