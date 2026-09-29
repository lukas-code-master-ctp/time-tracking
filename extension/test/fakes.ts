/** Fakes for the Remote (Firestore/Storage), AuthService, capture and image processing, plus an App factory. */
import {
  CONSENT_VERSION,
  type ActivitySlot,
  type OrgConfig,
  type ScreenshotMeta,
  type Session,
  type UserProfile,
} from '@timetracking/shared';
import { App } from '../src/background/app';
import { JoinError, type AuthService, type AuthUser } from '../src/background/auth';
import type { ImageProcessor, ProcessedImage } from '../src/background/image';
import type { Remote } from '../src/background/remote';
import type { Capturer, CaptureTarget } from '../src/background/screenshots';
import { StateStore } from '../src/background/state';
import { BackendError } from '../src/background/sync';
import { installChrome, type ChromeMock } from './chromeMock';

export type BackendCall =
  | { op: 'upsertActivity'; docId: string; data: ActivitySlot }
  | { op: 'createSession'; sessionId: string; data: Session }
  | { op: 'heartbeat'; sessionId: string; at: number }
  | { op: 'closeSession'; sessionId: string; endedAt: number }
  | { op: 'acceptConsent'; uid: string; at: number; version: string }
  | { op: 'uploadScreenshot'; path: string; size: number }
  | { op: 'screenshotExists'; path: string }
  | { op: 'putScreenshotMeta'; id: string; meta: ScreenshotMeta };

export const ORG: OrgConfig = {
  allowedDomain: 'compratuparcela.cl',
  screenshotsEnabled: false,
  blurScreenshots: true,
  screenshotRetentionDays: 90,
  updatedAt: 1,
  updatedBy: 'system',
};

/** Mimics the relevant firestore.rules / storage.rules: closed sessions are immutable, files are never overwritten. */
export class FakeBackend implements Remote {
  calls: BackendCall[] = [];
  uid: string | null = 'u1';
  offline = false;
  /** Errors thrown by the next calls (FIFO), by code. */
  failures: string[] = [];
  activity = new Map<string, ActivitySlot>();
  sessions = new Map<string, Session>();
  org: OrgConfig | null = { ...ORG };
  orgFetches = 0;
  /** storage.rules refuse every upload (e.g. user disabled). */
  denyUploads = false;
  users = new Map<string, Partial<UserProfile>>();
  files = new Map<string, number>();
  screenshots = new Map<string, ScreenshotMeta>();

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
  async fetchOrgConfig(): Promise<OrgConfig | null> {
    this.check();
    // Counted apart: config reads happen on their own schedule and would make `calls` noisy.
    this.orgFetches++;
    return this.org ? { ...this.org } : null;
  }
  async acceptConsent(uid: string, at: number, version: string): Promise<void> {
    this.check();
    this.calls.push({ op: 'acceptConsent', uid, at, version });
    this.users.set(uid, { ...this.users.get(uid), consentAcceptedAt: at, consentVersion: version });
  }
  async uploadScreenshot(path: string, jpeg: Uint8Array<ArrayBuffer>): Promise<void> {
    this.check();
    if (this.denyUploads) throw new BackendError('permission-denied');
    // storage.rules: `resource == null` → a second upload is refused.
    if (this.files.has(path)) throw new BackendError('permission-denied');
    this.calls.push({ op: 'uploadScreenshot', path, size: jpeg.byteLength });
    this.files.set(path, jpeg.byteLength);
  }
  async screenshotExists(path: string): Promise<boolean> {
    this.check();
    this.calls.push({ op: 'screenshotExists', path });
    return this.files.has(path);
  }
  async putScreenshotMeta(id: string, meta: ScreenshotMeta): Promise<void> {
    this.check();
    const existing = this.screenshots.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(meta)) throw new BackendError('permission-denied');
    this.calls.push({ op: 'putScreenshotMeta', id, meta });
    this.screenshots.set(id, meta);
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

/** Joined member who already accepted the current notice. */
export const PROFILE: UserProfile = {
  email: 'ana@compratuparcela.cl',
  displayName: 'ana',
  photoURL: null,
  role: 'member',
  status: 'active',
  createdAt: 1,
  consentAcceptedAt: 2,
  consentVersion: CONSENT_VERSION,
};

export class FakeAuth implements AuthService {
  user: AuthUser | null = { uid: 'u1', email: 'ana@compratuparcela.cl', displayName: 'ana' };
  joinResult: UserProfile | JoinError = PROFILE;
  signedOut = 0;
  private listeners: ((u: AuthUser | null) => void)[] = [];

  async ready(): Promise<void> {}
  currentUser(): AuthUser | null {
    return this.user;
  }
  async signInDev(email: string): Promise<AuthUser> {
    this.setUser({ uid: `dev-${email}`, email, displayName: null });
    return this.user as AuthUser;
  }
  async signInInteractive(): Promise<AuthUser> {
    throw new Error('not implemented');
  }
  async signOut(): Promise<void> {
    this.setUser(null);
    this.signedOut++;
  }
  onChange(cb: (u: AuthUser | null) => void): void {
    this.listeners.push(cb);
  }
  clearListeners(): void {
    this.listeners = [];
  }
  /** Simulates Firebase changing the user (sign-in, token revoked…). */
  setUser(u: AuthUser | null): void {
    this.user = u;
    for (const l of this.listeners) l(u);
  }
  async joinOrg(): Promise<UserProfile> {
    if (this.joinResult instanceof JoinError) throw this.joinResult;
    return this.joinResult;
  }
}

/** Capture target: the focused window, unless `none`. Records captures. */
export class FakeCapturer implements Capturer {
  none = false;
  fail = false;
  captures: number[] = [];
  async target(): Promise<CaptureTarget | null> {
    return this.none ? null : { windowId: 1 };
  }
  async capture(windowId: number): Promise<string> {
    if (this.fail) throw new Error('Cannot access contents of url "chrome://newtab/"');
    this.captures.push(windowId);
    return 'data:image/jpeg;base64,/9j/AA==';
  }
}

export class FakeImages implements ImageProcessor {
  calls: { blur: boolean }[] = [];
  async process(_dataUrl: string, opts: { blur: boolean }): Promise<ProcessedImage> {
    this.calls.push(opts);
    return { bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), width: 1280, height: 720, blurred: opts.blur };
  }
}

export interface Harness {
  chrome: ChromeMock;
  backend: FakeBackend;
  auth: FakeAuth;
  capturer: FakeCapturer;
  images: FakeImages;
  app: App;
  /** Returned by `random()` (screenshot instant inside the block). */
  random: { value: number };
  /** Waits for every queued critical section (the mutex is FIFO). */
  settle(): Promise<void>;
  /** Simulates the service worker being killed and started again (same storage). */
  restart(): Promise<App>;
}

export const TAB_URL = 'https://docs.example.com/doc/1?secret=1#h';

/**
 * Chrome with one focused window whose active tab is `TAB_URL` (id 11) and a
 * second tab `https://mail.example.org/inbox` (id 12). Profile already joined
 * (with the current consent).
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
  const capturer = new FakeCapturer();
  const images = new FakeImages();
  const random = { value: 0.5 };
  const make = (): App => {
    const app = new App({
      store: new StateStore({ area: chromeMock.local }),
      backend,
      auth,
      images,
      capturer,
      random: () => random.value,
      sessionArea: chromeMock.session,
    });
    return app;
  };
  const h: Harness = {
    chrome: chromeMock,
    backend,
    auth,
    capturer,
    images,
    random,
    app: make(),
    async settle() {
      // Let fire-and-forget kicks queue their sections, then drain.
      for (let i = 0; i < 5; i++) {
        await h.app.store.run(() => undefined);
        await h.app.sync.kick();
        await h.app.screenshots.drain();
        await Promise.resolve();
      }
    },
    async restart() {
      // Only the new worker listens to auth changes (Chrome listeners are not re-registered in tests).
      auth.clearListeners();
      h.app = make();
      h.app.watchAuth();
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
