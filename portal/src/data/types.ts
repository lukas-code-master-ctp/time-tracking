/**
 * Everything the pages need from Firebase, behind interfaces so components
 * are tested with in-memory fakes (see test/fakes.ts).
 */
import type {
  Absence,
  ActiveBreak,
  ActivitySlot,
  Announcement,
  AnnouncementRead,
  AttendancePhoto,
  AttendanceSettings,
  Celebration,
  DailyReport,
  DailyReportDraft,
  Kiosk,
  Invitation,
  MoodWeek,
  Feedback,
  BreakVideosConfig,
  OrgConfig,
  PersonGroup,
  PersonSchedule,
  Role,
  ScheduleConfig,
  ScreenshotMeta,
  Session,
  UserProfile,
  UserStatus,
  WithId,
  Workplace,
} from '@timetracking/shared';

export interface TimeRange {
  /** Inclusive (ms). */
  from: number;
  /** Exclusive (ms). */
  to: number;
}

export interface DataSource {
  getOrgConfig(): Promise<OrgConfig | null>;
  /** Writes the whole `config/org` (the 6 fields). */
  saveOrgConfig(config: OrgConfig): Promise<void>;
  /** `config/breakVideos`, raw (read it with `breakVideosForm`); null when it does not exist. */
  getBreakVideos(): Promise<unknown>;
  saveBreakVideos(config: BreakVideosConfig): Promise<void>;

  /** `config/schedule` when it exists and is valid (`readScheduleConfig`), otherwise null. */
  getScheduleConfig(): Promise<ScheduleConfig | null>;
  /** Writes the whole `config/schedule` (the 6 fields). */
  saveScheduleConfig(config: ScheduleConfig): Promise<void>;
  /** Deletes `config/schedule` (back to "no schedule"). */
  deleteScheduleConfig(): Promise<void>;
  /** Every valid `schedules/{uid}` (id = uid); invalid documents are left out. */
  listPersonSchedules(): Promise<WithId<PersonSchedule>[]>;
  /** `schedules/{uid}` when it exists and is valid, otherwise null. */
  getPersonSchedule(uid: string): Promise<PersonSchedule | null>;
  /** Writes the whole `schedules/{uid}` (the 3 fields). */
  savePersonSchedule(uid: string, schedule: PersonSchedule): Promise<void>;
  /** Deletes `schedules/{uid}` ("Volver al general"). */
  deletePersonSchedule(uid: string): Promise<void>;

  listUsers(): Promise<WithId<UserProfile>[]>;
  getUser(uid: string): Promise<WithId<UserProfile> | null>;
  updateUser(uid: string, patch: { role: Role; status: UserStatus }): Promise<void>;
  /** Office or field (spec 2026-11-13-minuta-terreno). */
  setWorkplace(uid: string, workplace: Workplace): Promise<void>;

  listInvitations(): Promise<WithId<Invitation>[]>;
  /** Full `set` of `invitations/{id}` (create or update). */
  putInvitation(id: string, invitation: Invitation): Promise<void>;

  /** Activity blocks with `slotStart` in the range (all users, or one). */
  listActivity(range: TimeRange, uid?: string): Promise<ActivitySlot[]>;
  /**
   * Sessions that may overlap the range: started in
   * `[from − lookback, to)` plus every still-open session.
   */
  listSessions(range: TimeRange, uid?: string): Promise<WithId<Session>[]>;
  listScreenshots(uid: string, range: TimeRange): Promise<WithId<ScreenshotMeta>[]>;
  /** Answered active break reminders of `uid` whose `start` is in the range. */
  listBreaks(uid: string, range: TimeRange): Promise<ActiveBreak[]>;
  /**
   * Justified absences touching `fromDate..toDate` (inclusive, `YYYY-MM-DD`),
   * of everybody or of one person. `[]` while the rules are not deployed.
   */
  listAbsences(fromDate: string, toDate: string, uid?: string): Promise<WithId<Absence>[]>;
  /** Requests from the people still waiting for an admin (`status == 'pending'`). `[]` while the rules are not deployed. */
  listPendingAbsences(): Promise<WithId<Absence>[]>;
  /** Writes the whole absence: a new document when `id` is null. Returns its id. */
  saveAbsence(id: string | null, absence: Absence): Promise<string>;
  deleteAbsence(id: string): Promise<void>;
  /**
   * Internal announcements (spec 2026-11-05-comunicados), newest first.
   * `[]` while the rules are not deployed.
   */
  listAnnouncements(): Promise<WithId<Announcement>[]>;
  /** Every read confirmation. `[]` while the rules are not deployed. */
  listAnnouncementReads(): Promise<AnnouncementRead[]>;
  /** Publishes a new announcement; returns its id. */
  createAnnouncement(announcement: Announcement): Promise<string>;
  /**
   * Changes a scheduled announcement (text, time, recipients) or adds the
   * fields of 0.2.29 to an old one (spec 2026-11-13-grupos-y-comunicados-agendados).
   */
  updateAnnouncement(
    id: string,
    patch: Partial<Pick<Announcement, 'title' | 'body' | 'authorName' | 'publishAt' | 'audience' | 'groupIds'>>,
  ): Promise<void>;
  /** Archives (a time) or brings back (null) an announcement. */
  setAnnouncementArchived(id: string, archivedAt: number | null): Promise<void>;
  deleteAnnouncement(id: string): Promise<void>;
  /** Every valid `groups/{id}` (spec 2026-11-13-grupos-y-comunicados-agendados). `[]` while the rules are not deployed. */
  listGroups(): Promise<WithId<PersonGroup>[]>;
  /** Writes the whole group: a new document when `id` is null. Returns its id. */
  saveGroup(id: string | null, group: PersonGroup): Promise<string>;
  deleteGroup(id: string): Promise<void>;
  /** Every valid `celebrations/{uid}` (id = uid). `[]` while the rules are not deployed. */
  listCelebrations(): Promise<WithId<Celebration>[]>;
  /** Writes the whole `celebrations/{uid}`. */
  saveCelebration(uid: string, celebration: Celebration): Promise<void>;
  /**
   * Daily reports of the days `fromDate`…`toDate` (YYYY-MM-DD, inclusive),
   * spec 2026-11-13-minuta-diaria. `[]` while the rules are not deployed.
   */
  listDailyReports(fromDate: string, toDate: string): Promise<WithId<DailyReport>[]>;
  /** Ids of the groups whose members include `uid` (phone page of the field, spec 2026-11-13-minuta-terreno). */
  listMyGroupIds(uid: string): Promise<string[]>;
  /** `dailyReports/{docId}` when it exists and is valid, otherwise null. */
  getDailyReport(docId: string): Promise<DailyReport | null>;
  /** Writes the whole `dailyReports/{docId}` (create, or a correction the same day). */
  putDailyReport(docId: string, report: DailyReport): Promise<void>;
  /** Calls `draftDailyReport`: transcript and draft of a recording (base64). */
  draftDailyReport(audio: string, mimeType: string): Promise<DailyReportDraft>;
  /** Every `moodWeeks/{YYYY-Www}` (anonymous counters of the mood pulse). `[]` while the rules are not deployed. */
  listMoodWeeks(): Promise<WithId<MoodWeek>[]>;
  /**
   * Valid anonymous comments (spec 2026-11-13-comentarios-anonimos) of the
   * ISO weeks `fromWeek` onwards. `[]` while the rules are not deployed.
   */
  listFeedback(fromWeek: string): Promise<WithId<Feedback>[]>;
  /** Removes a comment (moderation). */
  deleteFeedback(id: string): Promise<void>;
  /**
   * Every valid `attendanceSettings/{uid}` (id = uid): RUT and attendance mode
   * (spec 2026-11-10-marcaciones). `[]` while the rules are not deployed.
   */
  listAttendanceSettings(): Promise<WithId<AttendanceSettings>[]>;
  /** Writes the whole `attendanceSettings/{uid}`. */
  saveAttendanceSettings(uid: string, settings: AttendanceSettings): Promise<void>;
  /**
   * Kiosk photos (`attendancePhotos`) of the days `fromDate`…`toDate`
   * (YYYY-MM-DD, inclusive). `[]` while the rules are not deployed.
   */
  listAttendancePhotos(fromDate: string, toDate: string): Promise<WithId<AttendancePhoto>[]>;
  /** Every valid `kiosks/{id}`. `[]` while the rules are not deployed. */
  listKiosks(): Promise<WithId<Kiosk>[]>;
  /** New `kiosks/{id}` (id = SHA-256 of the device's token). */
  createKiosk(id: string, kiosk: Kiosk): Promise<void>;
  /** Stops a kiosk from marking (cannot be undone: create a new one). */
  revokeKiosk(id: string, revokedAt: number): Promise<void>;
  deleteKiosk(id: string): Promise<void>;
  /** Download URL of a Storage object (admins may read every screenshot). */
  screenshotUrl(storagePath: string): Promise<string>;
}

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  /**
   * False only for an email/password account whose address was not confirmed
   * yet: such a session never calls `joinOrg` (Google accounts are verified).
   */
  emailVerified?: boolean;
}

/** Result of an email/password step that does not leave the person signed in. */
export type PasswordOutcome = 'signed-in' | 'verification-sent';

export interface AuthApi {
  /** Subscribes to sign-in changes; returns the unsubscribe function. */
  onChange(cb: (user: AuthUser | null) => void): () => void;
  /** Google sign-in (popup, restricted to the Workspace domain). */
  signIn(): Promise<void>;
  /**
   * Email and password. An unverified address gets a new verification email
   * and the session is closed (`'verification-sent'`).
   */
  signInWithPassword(email: string, password: string): Promise<PasswordOutcome>;
  /** Creates an email/password account, sends the verification email and signs out. */
  createPasswordAccount(email: string, password: string): Promise<void>;
  /** Sends the reset link (also lets a Google account add a password). Silent for unknown emails. */
  sendPasswordReset(email: string): Promise<void>;
  /** Dev build only: fake Google credential accepted by the Auth emulator. */
  signInDev?: (email: string) => Promise<void>;
  signOut(): Promise<void>;
  /** Calls the `joinOrg` callable. Throws {@link JoinError}. */
  joinOrg(): Promise<UserProfile>;
}

export class JoinError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'JoinError';
  }
}

export interface Backend {
  auth: AuthApi;
  data: DataSource;
}
