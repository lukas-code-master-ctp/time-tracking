/** Fakes for the Remote (Firestore/Storage), AuthService, capture and image processing, plus an App factory. */
import {
  CONSENT_VERSION,
  type Absence,
  type ActiveBreak,
  type ActivitySlot,
  type Announcement,
  type AnnouncementRead,
  type Celebration,
  type OrgConfig,
  type ScreenshotMeta,
  type Session,
  type UserProfile,
  type WithId,
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
  | { op: 'putScreenshotMeta'; id: string; meta: ScreenshotMeta }
  | { op: 'createAbsence'; id: string; data: Absence }
  | { op: 'deleteAbsence'; id: string }
  | { op: 'putBreak'; docId: string; data: ActiveBreak }
  | { op: 'putAnnouncementRead'; docId: string; data: AnnouncementRead }
  | { op: 'putMood'; uid: string; week: string; date: string; score: number }
  | { op: 'putFeedback'; uid: string; week: string; date: string; tone: string; text: string };

export const ORG: OrgConfig = {
  allowedDomains: ['impulseai.cl', 'compratuparcela.cl'],
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
  /** `absences/{id}` (spec 2026-10-22-solicitud-ausencias). */
  absences = new Map<string, Absence>();
  celebrations = new Map<string, Celebration>();
  celebrationFetches = 0;
  org: OrgConfig | null = { ...ORG };
  /** `config/breakVideos` (raw). */
  breakVideos: unknown = null;
  orgFetches = 0;
  /** Raw `config/schedule` (null = missing). */
  schedule: unknown = null;
  /** Raw `schedules/{uid}` by uid. */
  personSchedules = new Map<string, unknown>();
  /** `attendanceSettings/{uid}` (spec 2026-11-10-marcaciones). */
  attendance = new Map<string, unknown>();
  scheduleFetches = 0;
  /** Errors of the next schedule reads (apart from `failures`, which other ops consume). */
  scheduleFailures: string[] = [];
  /** Network latency of the schedule reads (setTimeout: fake timers advance it). The answer is the data at request time. */
  scheduleDelayMs = 0;
  /** Behave like firestore.rules before 2026-09-30 (no `meetingSeconds`). */
  legacyActivityRules = false;
  /** storage.rules refuse every upload (e.g. user disabled). */
  denyUploads = false;
  users = new Map<string, Partial<UserProfile>>();
  files = new Map<string, number>();
  screenshots = new Map<string, ScreenshotMeta>();
  breaks = new Map<string, ActiveBreak>();
  /** `announcements/{id}` and `announcementReads/{id}` (spec 2026-11-05-comunicados). */
  announcements = new Map<string, Announcement>();
  announcementReads = new Map<string, AnnouncementRead>();
  announcementFetches = 0;

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
    // firestore.rules before 2026-09-30: `meetingSeconds` is an unknown field.
    if (this.legacyActivityRules && 'meetingSeconds' in data) throw new BackendError('permission-denied');
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
  async findOpenKioskSession(uid: string): Promise<{ id: string; startedAt: number } | null> {
    this.check();
    const open = [...this.sessions.entries()]
      .filter(([, s]) => s.uid === uid && s.endedAt === null && s.source === 'kiosk')
      .sort(([, a], [, b]) => b.startedAt - a.startedAt);
    return open[0] ? { id: open[0][0], startedAt: open[0][1].startedAt } : null;
  }
  /** kioskPunch: opens (`in`) or closes (`out`) a kiosk work day on the server. */
  kioskPunch(uid: string, action: 'in' | 'out', at: number, sessionId = `kiosk-${at}`): string {
    if (action === 'in') {
      this.sessions.set(sessionId, {
        uid, startedAt: at, endedAt: null, endReason: null, lastHeartbeatAt: at, source: 'kiosk', kioskId: 'k1',
      });
      return sessionId;
    }
    for (const [id, s] of this.sessions) {
      if (s.uid === uid && s.endedAt === null) {
        Object.assign(s, { endedAt: at, endReason: 'manual', closedByKioskId: 'k1' });
        return id;
      }
    }
    return '';
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
  async putBreak(docId: string, data: ActiveBreak): Promise<void> {
    this.check();
    const existing = this.breaks.get(docId);
    // Written once (a retry with the same data is fine).
    if (existing && JSON.stringify(existing) !== JSON.stringify(data)) throw new BackendError('permission-denied');
    this.calls.push({ op: 'putBreak', docId, data });
    this.breaks.set(docId, data);
  }
  /** `moodVotes` days by `uid_week` and `moodWeeks` counters by week. */
  moodVotes = new Map<string, string[]>();
  moodWeeks = new Map<string, Record<string, number>>();
  async putMood(uid: string, week: string, date: string, score: number): Promise<void> {
    this.check();
    const key = `${uid}_${week}`;
    const dates = this.moodVotes.get(key) ?? [];
    // One answer per person and day.
    if (dates.includes(date)) throw new BackendError('permission-denied');
    this.calls.push({ op: 'putMood', uid, week, date, score });
    this.moodVotes.set(key, [...dates, date]);
    const counters = this.moodWeeks.get(week) ?? {};
    counters[`n${score}`] = (counters[`n${score}`] ?? 0) + 1;
    this.moodWeeks.set(week, counters);
  }
  /** `feedbackVotes` days by `uid_week`; `feedback` documents as written (no uid). */
  feedbackVotes = new Map<string, string[]>();
  feedback: { week: string; tone: string; text: string }[] = [];
  async putFeedback(uid: string, week: string, date: string, tone: string, text: string): Promise<void> {
    this.check();
    const key = `${uid}_${week}`;
    const dates = this.feedbackVotes.get(key) ?? [];
    if (dates.includes(date)) throw new BackendError('permission-denied');
    this.calls.push({ op: 'putFeedback', uid, week, date, tone, text });
    this.feedbackVotes.set(key, [...dates, date]);
    this.feedback.push({ week, tone, text });
  }
  async fetchBreakVideos(): Promise<unknown> {
    this.check();
    return this.breakVideos;
  }
  async fetchOrgConfig(): Promise<OrgConfig | null> {
    this.check();
    // Counted apart: config reads happen on their own schedule and would make `calls` noisy.
    this.orgFetches++;
    return this.org ? { ...this.org } : null;
  }
  async fetchSchedule(uid: string): Promise<{ config: unknown; person: unknown; attendance: unknown }> {
    if (this.offline) throw new TypeError('Failed to fetch');
    const code = this.scheduleFailures.shift();
    if (code) throw new BackendError(code);
    this.scheduleFetches++;
    const answer = {
      config: structuredClone(this.schedule),
      person: structuredClone(this.personSchedules.get(uid) ?? null),
      attendance: structuredClone(this.attendance.get(uid) ?? null),
    };
    if (this.scheduleDelayMs > 0) await new Promise((r) => setTimeout(r, this.scheduleDelayMs));
    return answer;
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

  async fetchCelebrations(): Promise<WithId<Celebration>[]> {
    this.check();
    this.celebrationFetches++;
    return [...this.celebrations.entries()].map(([id, c]) => ({ ...structuredClone(c), id }));
  }
  async listAbsences(uid: string): Promise<WithId<Absence>[]> {
    this.check();
    return [...this.absences.entries()].filter(([, a]) => a.uid === uid).map(([id, a]) => ({ ...structuredClone(a), id }));
  }
  async createAbsence(data: Absence): Promise<string> {
    this.check();
    // firestore.rules: the person's own request, pending.
    if (data.status !== 'pending' || data.createdBy !== data.uid) throw new BackendError('permission-denied');
    const id = `abs-${this.absences.size + 1}`;
    this.calls.push({ op: 'createAbsence', id, data });
    this.absences.set(id, structuredClone(data));
    return id;
  }
  async deleteAbsence(id: string): Promise<void> {
    this.check();
    const a = this.absences.get(id);
    if (a && a.status !== 'pending') throw new BackendError('permission-denied');
    this.calls.push({ op: 'deleteAbsence', id });
    this.absences.delete(id);
  }

  async listAnnouncements(uid: string, max: number): Promise<WithId<unknown>[]> {
    this.check();
    this.announcementFetches++;
    // Like the query: only documents with `audience` containing '*' or uid, newest publishAt first.
    return [...this.announcements.entries()]
      .filter(([, a]) => Array.isArray(a.audience) && (a.audience.includes('*') || a.audience.includes(uid)))
      .map(([id, a]) => ({ ...structuredClone(a), id }))
      .sort((a, b) => (b.publishAt ?? 0) - (a.publishAt ?? 0))
      .slice(0, max);
  }
  async listAnnouncementReads(uid: string): Promise<string[]> {
    this.check();
    return [...this.announcementReads.values()].filter((r) => r.uid === uid).map((r) => r.announcementId);
  }
  async putAnnouncementRead(docId: string, data: AnnouncementRead): Promise<void> {
    this.check();
    // firestore.rules: the announcement exists; written once.
    const existing = this.announcementReads.get(docId);
    if (!this.announcements.has(data.announcementId)) throw new BackendError('permission-denied');
    if (existing && JSON.stringify(existing) !== JSON.stringify(data)) throw new BackendError('permission-denied');
    this.calls.push({ op: 'putAnnouncementRead', docId, data });
    this.announcementReads.set(docId, data);
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
