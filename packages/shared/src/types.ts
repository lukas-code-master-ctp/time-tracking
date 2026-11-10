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
  /**
   * 1–10 Workspace domains (lowercase, without `@`, unique). Old documents may
   * still carry a single `allowedDomain` string: read them with
   * `readAllowedDomains`.
   */
  allowedDomains: string[];
  screenshotsEnabled: boolean;
  blurScreenshots: boolean;
  screenshotRetentionDays: number;
  /**
   * The work day clock in the extension popup stops during the lunch of the
   * schedule. Optional: missing in older documents (= false, the clock keeps
   * running). It only changes what the popup shows, never what is measured.
   */
  pauseTimerAtLunch?: boolean;
  /**
   * "Pausa activa" (spec 2026-10-21-pausa-activa): the extension reminds the
   * person to take a short break with an exercise after `activeBreakIntervalMinutes`
   * of continuous work or, with `activeBreakMode: 'daily'`, `activeBreaksPerDay`
   * times a day spread over the schedule; the break lasts `activeBreakMinutes`.
   * All optional (missing = off / defaults): read them with `readActiveBreakSettings`.
   */
  activeBreaksEnabled?: boolean;
  activeBreakMode?: 'interval' | 'daily' | 'times';
  activeBreakIntervalMinutes?: number;
  activeBreaksPerDay?: number;
  /** `times` mode: clock times "HH:MM" (1–8, America/Santiago). */
  activeBreakTimes?: string[];
  activeBreakMinutes?: number;
  /**
   * "Pulso de ánimo" (spec 2026-11-05-pulso-de-animo): the extension asks
   * "¿Cómo estuvo tu día?" when the work day is closed. Optional (missing =
   * off): read it with `readMoodPulseEnabled`.
   */
  moodPulseEnabled?: boolean;
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

/** Where a work day was opened: the extension button (default) or the kiosk. */
export type SessionSource = 'extension' | 'kiosk';

/** `sessions/{sessionId}` — one work day ("jornada"). */
export interface Session {
  uid: string;
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  endReason: SessionEndReason | null;
  lastHeartbeatAt: EpochMs;
  /**
   * `'kiosk'`: opened by the attendance kiosk (spec 2026-11-10-marcaciones,
   * Cloud Function `kioskPunch`). It has no heartbeat: while open it lasts
   * until now (`sessionEndAt`). Missing = opened by the extension.
   */
  source?: SessionSource;
  /** Kiosk that opened it (`kiosks/{id}`), only with `source: 'kiosk'`. */
  kioskId?: string;
  /** Kiosk that closed it ("Salida" marked on the kiosk), whatever opened it. */
  closedByKioskId?: string;
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
   * Tracked seconds without keyboard/mouse activity while a web meeting was
   * in progress in Chrome (spec 2026-09-30). Never overlaps `activeSeconds`:
   * `activeSeconds + meetingSeconds <= trackedSeconds`. Missing in documents
   * written by extension 0.1.1 or older: read it as 0 (`meetingSecondsOf`).
   */
  meetingSeconds?: number;
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

/**
 * Answer to an active break reminder: done ("Tomé la pausa"), postponed
 * ("En 10 min") or skipped (closed, or replaced by the next reminder
 * without an answer).
 */
export type ActiveBreakStatus = 'taken' | 'postponed' | 'skipped';

/** `breaks/{uid_promptedAt}` — one answered active break reminder. */
export interface ActiveBreak {
  uid: string;
  /** Work day open when the reminder was shown. */
  sessionId: string;
  status: ActiveBreakStatus;
  /** When the reminder was shown (part of the document id). */
  promptedAt: EpochMs;
  /** When the person answered. */
  answeredAt: EpochMs;
  /**
   * `taken`: the break (`end - start` = the configured duration), shown in
   * the portal timeline. Otherwise both equal `answeredAt`.
   */
  start: EpochMs;
  end: EpochMs;
  /** Id of the suggested exercise (`ACTIVE_BREAK_EXERCISES`). */
  exercise: string;
}

/** Reason of a justified absence (labels in `ABSENCE_TYPE_LABELS`). */
export type AbsenceType = 'vacation' | 'medical' | 'errand' | 'permission' | 'other';

/**
 * A request made by the person from the extension is `pending` until an
 * admin approves or rejects it; what an admin records is `approved`. Only
 * approved absences justify time.
 */
export type AbsenceStatus = 'pending' | 'approved' | 'rejected';

/**
 * `absences/{autoId}` — a justified absence (spec 2026-10-22-ausencias-justificadas),
 * recorded by an admin or requested by the person (spec
 * 2026-10-22-solicitud-ausencias). Whole days: `startDate..endDate` (inclusive) with both
 * times null. By hours: one day (`startDate == endDate`) and
 * `startTime < endTime`. Dates `YYYY-MM-DD` and times `HH:MM` in America/Santiago.
 */
export interface Absence {
  uid: string;
  type: AbsenceType;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  /** Free comment ('' when none; required for `other`). Max 500 characters. */
  note: string;
  /** Missing in documents written before the requests (= approved): read it with `absenceStatus`. */
  status?: AbsenceStatus;
  createdAt: EpochMs;
  /** uid of the admin who recorded it, or of the person who requested it. */
  createdBy: string;
  updatedAt: EpochMs;
  /** uid of who last changed it (the admin who approved or rejected a request). */
  updatedBy: string;
}

/**
 * `announcements/{autoId}` — an internal announcement published by an admin
 * in the portal (spec 2026-11-05-comunicados). Every active person sees it
 * in the extension until they confirm they read it. Never edited: an admin
 * archives it (`archivedAt`) to stop showing it, or deletes it.
 */
export interface Announcement {
  /** 1–120 characters. */
  title: string;
  /** 1–4000 characters, plain text (line breaks kept). */
  body: string;
  /** Name shown as the sender ("Recursos Humanos", the admin's name…). Max 80. */
  authorName: string;
  createdAt: EpochMs;
  /** uid of the admin who published it. */
  createdBy: string;
  /** When an admin archived it (null = shown in the extension). */
  archivedAt: EpochMs | null;
}

/** `announcementReads/{announcementId_uid}` — "Confirmo que lo leí", written once by the person. */
export interface AnnouncementRead {
  announcementId: string;
  uid: string;
  readAt: EpochMs;
}

/**
 * `celebrations/{uid}` — birthday and hire date of a person (spec
 * 2026-11-05-cumpleanos-aniversarios), recorded by an admin in the portal and
 * readable by every active person, so the extension popup can show the
 * team's birthdays and work anniversaries. Members cannot read other
 * `users` docs: the name is copied here.
 */
export interface Celebration {
  /** Copy of `users/{uid}.displayName` (or the email) when it was saved. */
  displayName: string;
  /** `MM-DD` (no year: the age is never stored); null = not recorded. */
  birthday: string | null;
  /** `YYYY-MM-DD` in America/Santiago; null = not recorded. */
  hireDate: string | null;
  /** Copy of `users/{uid}.status == 'active'`: disabled people are not shown. */
  active: boolean;
  /**
   * uid of the person's boss ("jefatura"): their popup also warns the day
   * before ("Mañana Juan está de cumpleaños"). Optional: missing = null.
   */
  managerUid?: string | null;
  updatedAt: EpochMs;
  /** uid of the admin who last changed it. */
  updatedBy: string;
}

/** Day of the week, as used by the keys of `WeekSchedule`. */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * Working hours of one day of the week (spec 2026-09-30-horarios.md). Times
 * are wall-clock `HH:MM` (24 h) in America/Santiago. `start < end` (no work
 * day crosses midnight); lunch is both null or both set with
 * `start <= lunchStart < lunchEnd <= end`.
 */
export interface DaySchedule {
  start: string;
  end: string;
  lunchStart: string | null;
  lunchEnd: string | null;
}

/** One entry per weekday; `null` = day off. */
export type WeekSchedule = Record<Weekday, DaySchedule | null>;

/** `config/schedule`: general working hours of the organization. */
export interface ScheduleConfig {
  week: WeekSchedule;
  /** Days off, `YYYY-MM-DD` in America/Santiago (max 60, unique). */
  holidays: string[];
  /** Margin (0–60 min) before counting a late arrival or an early leave. */
  toleranceMinutes: number;
  remindersEnabled: boolean;
  updatedAt: EpochMs;
  /** uid of the admin who last changed it. */
  updatedBy: string;
}

/** `schedules/{uid}`: per-person exception; replaces only the `week`. */
export interface PersonSchedule {
  week: WeekSchedule;
  updatedAt: EpochMs;
  updatedBy: string;
}

/**
 * How a person marks the start and end of the work day (spec
 * 2026-11-10-marcaciones): the extension button, the kiosk at the office
 * entrance (with their RUT) or both. Decided by an admin.
 */
export type AttendanceMode = 'extension' | 'kiosk' | 'both';

/**
 * `attendanceSettings/{uid}` — RUT and attendance mode of a person, written by
 * an admin. Missing document = `mode: 'extension'` without RUT.
 */
export interface AttendanceSettings {
  /** Normalized RUT `12345678-K` (no dots, uppercase K), or null. Unique in the organization. */
  rut: string | null;
  mode: AttendanceMode;
  updatedAt: EpochMs;
  /** uid of the admin who last changed it. */
  updatedBy: string;
}

/**
 * `kiosks/{tokenHash}` — a device (tablet at the entrance) allowed to mark
 * attendance. The id is the SHA-256 (hex) of the secret token kept by the
 * device; the token itself is never stored.
 */
export interface Kiosk {
  /** 1–60 characters ("Recepción", "Oficina Providencia"…). */
  name: string;
  createdAt: EpochMs;
  createdBy: string;
  /** When an admin revoked it (null = it can mark). */
  revokedAt: EpochMs | null;
  /** Last mark accepted from it (written by `kioskPunch`). */
  lastUsedAt?: EpochMs | null;
}

/** Firestore documents together with their id. */
export type WithId<T> = T & { id: string };
