/**
 * Data model shared by extension, portal and functions (spec section 5).
 *
 * Decision: every point in time is stored as a plain number of milliseconds
 * since the Unix epoch (UTC), both on the client and in Firestore. We never
 * store Firestore `Timestamp` values. This keeps range queries trivial
 * (`where('slotStart', '>=', fromMs)`), avoids conversions between SDKs
 * (web, admin, rules tests) and makes documents directly serializable.
 */

/** Epoch milliseconds (UTC). */
export type EpochMs = number;

export type Role = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked';
export type SessionEndReason = 'manual' | 'auto';
export type IdleState = 'active' | 'idle' | 'locked';

/** `config/org` */
export interface OrgConfig {
  allowedDomain: string;
  screenshotsEnabled: boolean;
  blurScreenshots: boolean;
  screenshotRetentionDays: number;
  updatedAt: EpochMs;
  /** uid of the admin who last changed it (or 'system'). */
  updatedBy: string;
}

/** `invitations/{emailLower}` */
export interface Invitation {
  email: string;
  /** uid of the inviting admin. */
  invitedBy: string;
  invitedAt: EpochMs;
  status: InvitationStatus;
  acceptedAt?: EpochMs;
}

/** `users/{uid}` */
export interface UserProfile {
  email: string;
  displayName: string;
  photoURL: string | null;
  role: Role;
  status: UserStatus;
  createdAt: EpochMs;
  consentAcceptedAt?: EpochMs;
  consentVersion?: string;
}

/** `sessions/{sessionId}` — one work day ("jornada"). */
export interface Session {
  uid: string;
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  endReason: SessionEndReason | null;
  lastHeartbeatAt: EpochMs;
}

export interface UrlTime {
  /** Sanitized URL (no query, no hash, no credentials). */
  url: string;
  seconds: number;
}

/** `activity/{uid_slotStartMs}` — one 10-minute block. */
export interface ActivitySlot {
  uid: string;
  sessionId: string;
  /** Start of the clock-aligned 10-minute block. */
  slotStart: EpochMs;
  /** Seconds of the block measured while the work day was open (0..600). */
  trackedSeconds: number;
  /** Seconds with keyboard/mouse activity (0..trackedSeconds). */
  activeSeconds: number;
  /** Tracked seconds while no Chrome window had focus. */
  outsideChromeSeconds: number;
  /**
   * Seconds per domain (hostname without leading "www."). Keys contain dots:
   * write the whole map with set()/merge, never with dotted update() paths.
   */
  domains: Record<string, number>;
  /** Top URLs of the block, sorted by seconds desc (max 20). */
  urls: UrlTime[];
}

/** `screenshots/{id}` */
export interface ScreenshotMeta {
  uid: string;
  sessionId: string;
  takenAt: EpochMs;
  storagePath: string;
  blurred: boolean;
  width: number;
  height: number;
}

/** Firestore documents together with their id. */
export type WithId<T> = T & { id: string };
