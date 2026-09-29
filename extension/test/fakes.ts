/** Fakes for Backend (Firestore) and AuthService, plus an App factory. */
import type { ActivitySlot, Session, UserProfile } from '@timetracking/shared';
import { App } from '../src/background/app';
import { JoinError, type AuthService, type AuthUser } from '../src/background/auth';
import { StateStore } from '../src/background/state';
import { BackendError, type Backend } from '../src/background/sync';
import { installChrome, type ChromeMock } from './chromeMock';

export type BackendCall =
  | { op: 'upsertActivity'; docId: string; data: ActivitySlot }
  | { op: 'createSession'; sessionId: string; data: Session }
  | { op: 'heartbeat'; sessionId: string; at: number }
  | { op: 'closeSession'; sessionId: string; endedAt: number };

/** Mimics the relevant firestore.rules: closed sessions are immutable. */
export class FakeBackend implements Backend {
  calls: BackendCall[] = [];
  uid: string | null = 'u1';
  offline = false;
  /** Errors thrown by the next calls (FIFO), by code. */
  failures: string[] = [];
  activity = new Map<string, ActivitySlot>();
  sessions = new Map<string, Session>();

  async currentUid(): Promise<string | null> {
    return this.uid;
  }

  private check(): void {
    if (this.offline) throw new TypeError('Failed to fetch');
    const code = this.failures.shift();
    if (code) throw new BackendError(code);
  }

  async upsertActivity(docId: string, data: ActivitySlot): Promise<void> {
    this.check();
    this.calls.push({ op: 'upsertActivity', docId, data });
    this.activity.set(docId, data);
  }
  async createSession(sessionId: string, data: Session): Promise<void> {
    this.check();
    const existing = this.sessions.get(sessionId);
    if (existing && existing.endedAt !== null) throw new BackendError('permission-denied');
    this.calls.push({ op: 'createSession', sessionId, data });
    if (!existing) this.sessions.set(sessionId, { ...data });
  }
  async heartbeat(sessionId: string, at: number): Promise<void> {
    this.check();
    const s = this.sessions.get(sessionId);
    if (!s || s.endedAt !== null) throw new BackendError('permission-denied');
    this.calls.push({ op: 'heartbeat', sessionId, at });
    s.lastHeartbeatAt = at;
  }
  async closeSession(sessionId: string, endedAt: number): Promise<void> {
    this.check();
    const s = this.sessions.get(sessionId);
    if (!s || s.endedAt !== null) throw new BackendError('permission-denied');
    this.calls.push({ op: 'closeSession', sessionId, endedAt });
    Object.assign(s, { endedAt, endReason: 'manual', lastHeartbeatAt: endedAt });
  }

  /** What autoCloseStaleSessions does on the server. */
  autoClose(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) Object.assign(s, { endedAt: s.lastHeartbeatAt, endReason: 'auto' });
  }

  ops(kind: BackendCall['op']): BackendCall[] {
    return this.calls.filter((c) => c.op === kind);
  }
}

export const PROFILE: UserProfile = {
  email: 'ana@compratuparcela.cl',
  displayName: 'ana',
  photoURL: null,
  role: 'member',
  status: 'active',
  createdAt: 1,
};

export class FakeAuth implements AuthService {
  user: AuthUser | null = { uid: 'u1', email: 'ana@compratuparcela.cl', displayName: 'ana' };
  joinResult: UserProfile | JoinError = PROFILE;
  signedOut = 0;

  async ready(): Promise<void> {}
  currentUser(): AuthUser | null {
    return this.user;
  }
  async signInDev(email: string): Promise<AuthUser> {
    this.user = { uid: `dev-${email}`, email, displayName: null };
    return this.user;
  }
  async signInInteractive(): Promise<AuthUser> {
    throw new Error('not implemented');
  }
  async signOut(): Promise<void> {
    this.user = null;
    this.signedOut++;
  }
  async joinOrg(): Promise<UserProfile> {
    if (this.joinResult instanceof JoinError) throw this.joinResult;
    return this.joinResult;
  }
}

export interface Harness {
  chrome: ChromeMock;
  backend: FakeBackend;
  auth: FakeAuth;
  app: App;
  /** Waits for every queued critical section (the mutex is FIFO). */
  settle(): Promise<void>;
  /** Simulates the service worker being killed and started again (same storage). */
  restart(): Promise<App>;
}

export const TAB_URL = 'https://docs.example.com/doc/1?secret=1#h';

/**
 * Chrome with one focused window whose active tab is `TAB_URL` (id 11) and a
 * second tab `https://mail.example.org/inbox` (id 12). Profile already joined.
 */
export async function createHarness(opts: { joined?: boolean } = {}): Promise<Harness> {
  const chromeMock = installChrome();
  chromeMock.setWindows([
    {
      id: 1,
      focused: true,
      tabs: [
        { id: 11, url: TAB_URL, active: true },
        { id: 12, url: 'https://mail.example.org/inbox', active: false },
      ],
    },
  ]);
  const backend = new FakeBackend();
  const auth = new FakeAuth();
  const make = (): App =>
    new App({ store: new StateStore({ area: chromeMock.local }), backend, auth, sessionArea: chromeMock.session });
  const h: Harness = {
    chrome: chromeMock,
    backend,
    auth,
    app: make(),
    async settle() {
      // Let fire-and-forget kicks queue their sections, then drain.
      for (let i = 0; i < 5; i++) {
        await h.app.store.run(() => undefined);
        await h.app.sync.kick();
        await Promise.resolve();
      }
    },
    async restart() {
      h.app = make();
      await h.app.start();
      return h.app;
    },
  };
  h.app.register();
  if (opts.joined !== false) await h.app.refreshProfile();
  return h;
}

/** Content script says hello from a tab. */
export function hello(h: Harness, tabId: number): Promise<void> {
  return h.app.tracker.onContentMessage({ type: 'hello' }, h.chrome.senderFor(tabId));
}

export function activity(h: Harness, tabId: number, t = Date.now()): Promise<void> {
  return h.app.tracker.onContentMessage({ type: 'activity', t }, h.chrome.senderFor(tabId));
}
