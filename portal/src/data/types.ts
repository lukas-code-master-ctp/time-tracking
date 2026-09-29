/**
 * Everything the pages need from Firebase, behind interfaces so components
 * are tested with in-memory fakes (see test/fakes.ts).
 */
import type {
  ActivitySlot,
  Invitation,
  OrgConfig,
  Role,
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
