/**
 * Everything the pages need from Firebase, behind interfaces so components
 * are tested with in-memory fakes (see test/fakes.ts).
 */
import type {
  Absence,
  ActiveBreak,
  ActivitySlot,
  Invitation,
  OrgConfig,
  PersonSchedule,
  Role,
  ScheduleConfig,
  ScreenshotMeta,
  Session,
  UserProfile,
  UserStatus,
  WithId,
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
  /** Download URL of a Storage object (admins may read every screenshot). */
  screenshotUrl(storagePath: string): Promise<string>;
}

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export interface AuthApi {
  /** Subscribes to sign-in changes; returns the unsubscribe function. */
  onChange(cb: (user: AuthUser | null) => void): () => void;
  /** Google sign-in (popup, restricted to the Workspace domain). */
  signIn(): Promise<void>;
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
