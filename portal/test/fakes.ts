/** In-memory {@link DataSource} / {@link AuthApi} for component tests. */
import { vi } from 'vitest';
import type {
  ActivitySlot,
  Invitation,
  OrgConfig,
  ScreenshotMeta,
  Session,
  UserProfile,
  WithId,
} from '@timetracking/shared';
import type { AuthApi, AuthUser, Backend, DataSource } from '../src/data/types';

export interface FakeDb {
  config: OrgConfig | null;
  users: WithId<UserProfile>[];
  invitations: WithId<Invitation>[];
  activity: ActivitySlot[];
  sessions: WithId<Session>[];
  screenshots: WithId<ScreenshotMeta>[];
}

export function emptyDb(): FakeDb {
  return { config: null, users: [], invitations: [], activity: [], sessions: [], screenshots: [] };
}

export function fakeData(db: FakeDb): DataSource & { [K in keyof DataSource]: ReturnType<typeof vi.fn> & DataSource[K] } {
  const data: DataSource = {
    getOrgConfig: async () => db.config,
    saveOrgConfig: async (c) => {
      db.config = c;
    },
    listUsers: async () => [...db.users],
    getUser: async (uid) => db.users.find((u) => u.id === uid) ?? null,
    updateUser: async (uid, patch) => {
      db.users = db.users.map((u) => (u.id === uid ? { ...u, ...patch } : u));
    },
    listInvitations: async () => [...db.invitations],
    putInvitation: async (id, inv) => {
      db.invitations = [...db.invitations.filter((i) => i.id !== id), { ...inv, id }];
    },
    listActivity: async (range, uid) =>
      db.activity.filter((a) => a.slotStart >= range.from && a.slotStart < range.to && (!uid || a.uid === uid)),
    listSessions: async (range, uid) =>
      db.sessions.filter((s) => (!uid || s.uid === uid) && (s.endedAt === null || s.startedAt < range.to)),
    listScreenshots: async (uid, range) =>
      db.screenshots.filter((s) => s.uid === uid && s.takenAt >= range.from && s.takenAt < range.to),
    screenshotUrl: async (path) => `https://example.test/${encodeURIComponent(path)}`,
  };
  for (const k of Object.keys(data) as (keyof DataSource)[]) {
    (data as unknown as Record<string, unknown>)[k] = vi.fn(data[k]);
  }
  return data as never;
}

export function fakeAuth(user: AuthUser | null, profile: UserProfile | Error): AuthApi {
  let listener: ((u: AuthUser | null) => void) | null = null;
  return {
    onChange(cb) {
      listener = cb;
      queueMicrotask(() => cb(user));
      return () => {
        listener = null;
      };
    },
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => listener?.(null)),
    joinOrg: vi.fn(async () => {
      if (profile instanceof Error) throw profile;
      return profile;
    }),
  };
}

export function backendOf(db: FakeDb, admin: WithId<UserProfile>): Backend {
  return {
    data: fakeData(db),
    auth: fakeAuth({ uid: admin.id, email: admin.email, displayName: admin.displayName }, admin),
  };
}

export const ADMIN: WithId<UserProfile> = {
  id: 'admin-1',
  email: 'lukas@impulseai.cl',
  displayName: 'Lukas Admin',
  photoURL: null,
  role: 'admin',
  status: 'active',
  createdAt: Date.UTC(2026, 8, 1),
};

export function member(id: string, displayName: string, extra: Partial<UserProfile> = {}): WithId<UserProfile> {
  return {
    id,
    email: `${id}@compratuparcela.cl`,
    displayName,
    photoURL: null,
    role: 'member',
    status: 'active',
    createdAt: Date.UTC(2026, 8, 1),
    ...extra,
  };
}

export function slot(uid: string, slotStart: number, tracked = 600, active = 480, extra: Partial<ActivitySlot> = {}): ActivitySlot {
  return {
    uid,
    sessionId: `s-${uid}`,
    slotStart,
    trackedSeconds: tracked,
    activeSeconds: active,
    outsideChromeSeconds: 0,
    domains: { 'mail.google.com': tracked },
    urls: [{ url: 'https://mail.google.com/mail/u/0/', seconds: tracked }],
    ...extra,
  };
}
