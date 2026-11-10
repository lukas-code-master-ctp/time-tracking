/**
 * When an open work day "ends" for the reports. Extension sessions send a
 * heartbeat every minute, so an open one lasts until its last heartbeat (a
 * session without signal is not counted after it). Kiosk sessions (spec
 * 2026-11-10-marcaciones) have no heartbeat: an open one lasts until `now`,
 * at most MAX_SESSION_MS (then `autoCloseStaleSessions` closes it). Pure.
 */
import { MAX_SESSION_MS, STALE_SESSION_MS } from './config.js';
import type { Session } from './types.js';

/** End of the session for the reports (closed: `endedAt`). Never before `startedAt`. */
export function sessionEndAt(session: Session, now?: number): number {
  if (session.endedAt !== null) return session.endedAt;
  if (session.source === 'kiosk' && now !== undefined) {
    return Math.max(session.startedAt, Math.min(now, session.startedAt + MAX_SESSION_MS));
  }
  return session.lastHeartbeatAt;
}

/**
 * True when the session is open and still alive: an extension session with a
 * recent heartbeat, or a kiosk session open for less than MAX_SESSION_MS.
 */
export function isSessionLive(session: Session, now?: number): boolean {
  if (session.endedAt !== null) return false;
  if (now === undefined) return true;
  if (session.source === 'kiosk') return now - session.startedAt <= MAX_SESSION_MS;
  return now - session.lastHeartbeatAt <= STALE_SESSION_MS;
}
