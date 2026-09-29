/**
 * Wires the background pieces together and registers every Chrome listener.
 * `register()` must run synchronously when the service worker starts (MV3
 * only delivers events to listeners added in the first turn of the script).
 *
 * The 30-second pulse (chrome.alarms) runs, in order: session pulse (blocks,
 * heartbeat, activity uploads) → `config/org` refresh when older than 5 min →
 * screenshot of the block if its random instant passed → screenshot uploads.
 */
import { CONSENT_VERSION, type OrgConfig, type UserProfile } from '@timetracking/shared';
import {
  isContentMessage,
  isPopupRequest,
  type PopupRequest,
  type PopupResponse,
  type StatusView,
} from '../messages';
import { AuthError, JoinError, type AuthService } from './auth';
import { todayTotals } from './daily';
import type { ImageProcessor } from './image';
import { enqueueOp } from './queue';
import type { Remote } from './remote';
import { ScreenshotManager, chromeCapturer, type Capturer } from './screenshots';
import { PULSE_ALARM, SessionError, SessionManager } from './session';
import type { StateStore, StorageAreaLike } from './state';
import { SyncEngine, errorCode } from './sync';
import { Tracker } from './tracker';

/** `config/org` is re-read at most this often from the pulse (spec: every 5 min). */
export const ORG_CONFIG_REFRESH_MS = 5 * 60_000;
/** …and when the worker wakes up, if older than this. */
export const ORG_CONFIG_WAKE_REFRESH_MS = 60_000;

export interface AppDeps {
  store: StateStore;
  backend: Remote;
  auth: AuthService;
  /** Resize/blur/encode of screenshots (OffscreenCanvas in the worker). */
  images: ImageProcessor;
  capturer?: Capturer;
  now?: () => number;
  random?: () => number;
  sessionArea?: StorageAreaLike | null;
}

export class App {
  readonly store: StateStore;
  readonly auth: AuthService;
  readonly backend: Remote;
  readonly tracker: Tracker;
  readonly sync: SyncEngine;
  readonly session: SessionManager;
  readonly screenshots: ScreenshotManager;
  private readonly now: () => number;

  constructor(deps: AppDeps) {
    this.store = deps.store;
    this.auth = deps.auth;
    this.backend = deps.backend;
    this.now = deps.now ?? Date.now;
    this.tracker = new Tracker({
      store: this.store,
      now: this.now,
      ...(deps.sessionArea !== undefined ? { sessionArea: deps.sessionArea } : {}),
    });
    // The session manager is created right after; the hook only runs later.
    let session: SessionManager | null = null;
    this.sync = new SyncEngine(
      this.store,
      deps.backend,
      { onSessionRejected: (id) => session?.closeLocally(id) ?? Promise.resolve() },
      this.now,
    );
    session = new SessionManager({
      store: this.store,
      tracker: this.tracker,
      sync: this.sync,
      auth: this.auth,
      now: this.now,
    });
    this.session = session;
    this.screenshots = new ScreenshotManager({
      store: this.store,
      remote: deps.backend,
      capturer: deps.capturer ?? chromeCapturer(),
      processor: deps.images,
      now: this.now,
      ...(deps.random ? { random: deps.random } : {}),
    });
  }

  register(): void {
    this.tracker.register();
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === PULSE_ALARM) void this.pulse().catch(logError('pulso'));
    });
    chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      // Extension pages (popup, or popup/consent opened in a tab) vs content scripts.
      const fromExtensionPage = (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
      if (!fromExtensionPage) {
        if (sender.tab && isContentMessage(msg)) {
          void this.tracker.onContentMessage(msg, sender).catch(logError('content'));
        }
        return false;
      }
      if (!isPopupRequest(msg)) return false;
      void this.handlePopup(msg).then(sendResponse);
      return true; // async response
    });
    chrome.runtime.onInstalled.addListener(() => void this.injectContentScripts());
    chrome.runtime.onStartup.addListener(() => void this.injectContentScripts());
    // Back online: retry the queues without waiting for the backoff.
    globalThis.addEventListener?.('online', () => {
      void this.sync.kick(true);
      void this.screenshots.drain(true);
    });
    this.watchAuth();
  }

  /**
   * Firebase dropped the session (token revoked, user deleted…) while a work
   * day is open: close it locally and queue the close (spec 3.6).
   */
  watchAuth(): void {
    this.auth.onChange(() => void this.session.checkUser().catch(logError('cambio de sesión')));
  }

  /** Every service-worker start. */
  async start(): Promise<void> {
    await this.session.rehydrate().catch(logError('rehidratación'));
    await this.refreshOrgConfig(ORG_CONFIG_WAKE_REFRESH_MS).catch(logError('config/org'));
    void this.screenshots.drain().catch(logError('capturas'));
  }

  /** chrome.alarms pulse (every 30 s while there is something to do). */
  async pulse(opts: { forceScreenshot?: boolean } = {}): Promise<string> {
    await this.session.pulse();
    await this.refreshOrgConfig(opts.forceScreenshot ? 0 : ORG_CONFIG_REFRESH_MS).catch(logError('config/org'));
    const shot = await this.screenshots.maybeCapture(opts.forceScreenshot ?? false);
    await this.screenshots.drain(opts.forceScreenshot ?? false);
    await this.store.run(() => this.session.ensureAlarm());
    return shot;
  }

  /**
   * Reads `config/org` when the cache is older than `maxAgeMs` (0 = always).
   * Needs a joined user (the config is readable by active users only). On
   * failure the previous cache stays.
   */
  async refreshOrgConfig(maxAgeMs: number): Promise<void> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    const due = await this.store.run(() => {
      const { profile, profileUid, org } = this.store.meta;
      if (!user || !profile || profileUid !== user.uid) return false;
      return !org || org.uid !== user.uid || this.now() - org.fetchedAt >= maxAgeMs;
    });
    if (!user || !due) return;
    let config: OrgConfig | null;
    try {
      config = await this.backend.fetchOrgConfig();
    } catch (err) {
      console.warn(`[timetracking] no se pudo leer config/org (${errorCode(err)})`);
      return;
    }
    await this.store.run(async () => {
      this.store.meta.org = {
        uid: user.uid,
        // Missing doc or fields: the safe defaults (no screenshots).
        screenshotsEnabled: config?.screenshotsEnabled === true,
        blurScreenshots: config?.blurScreenshots !== false,
        fetchedAt: this.now(),
      };
      await this.store.save('meta');
    });
  }

  /**
   * Content scripts declared in the manifest only reach pages loaded after
   * install/update; inject them into the tabs already open. Pages where
   * scripting is not allowed (chrome://, Web Store, discarded tabs) fail and
   * are ignored.
   */
  async injectContentScripts(): Promise<void> {
    const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0] ?? 'content.js';
    let tabs: chrome.tabs.Tab[] = [];
    try {
      tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    } catch {
      return;
    }
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined || tab.incognito || tab.discarded) return;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
        } catch {
          // not scriptable (chrome://, Web Store, error pages…)
        }
      }),
    );
  }

  // ---------- popup ----------

  async handlePopup(req: PopupRequest): Promise<PopupResponse> {
    try {
      let debug: unknown;
      // Dev-only debug hooks for the e2e test; the whole branch (and the
      // message types) is dropped from the prod bundle.
      if (__APP_ENV__ === 'dev') {
        if (req.type === 'debug.forcePulse' || req.type === 'debug.forceScreenshot') {
          debug = await this.pulse({ forceScreenshot: req.type === 'debug.forceScreenshot' });
          await this.sync.kick(true);
          return { ok: true, status: await this.status(), debug };
        }
        if (req.type === 'auth.devSignIn') {
          await this.auth.signInDev(req.email);
          await this.refreshProfile();
          return { ok: true, status: await this.status() };
        }
      }
      switch (req.type) {
        case 'status':
          break;
        case 'session.start':
          await this.session.start();
          void this.refreshOrgConfig(0).catch(logError('config/org'));
          break;
        case 'session.stop':
          await this.session.stop();
          break;
        case 'auth.signIn':
          await this.auth.signInInteractive();
          await this.refreshProfile();
          break;
        case 'auth.signOut':
          await this.signOut();
          break;
        case 'auth.refreshProfile':
          await this.refreshProfile();
          break;
        case 'consent.accept':
          await this.acceptConsent(req.version);
          break;
        case 'sync.now':
          await Promise.all([this.sync.kick(true), this.screenshots.drain(true)]);
          break;
        default:
          break;
      }
      return { ok: true, status: await this.status() };
    } catch (err) {
      const reason = err instanceof SessionError || err instanceof AuthError || err instanceof JoinError ? err.reason : undefined;
      const error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof SessionError || err instanceof AuthError)) console.warn('[timetracking] popup', err);
      return { ok: false, error, ...(reason ? { reason } : {}), status: await this.status().catch(() => undefined) } as PopupResponse;
    }
  }

  /** joinOrg for the signed-in user; keeps the profile or the rejection reason. */
  async refreshProfile(): Promise<void> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    if (!user) throw new AuthError('signed-out', 'Inicia sesión primero.');
    let profile: UserProfile | null = null;
    let joinError: { reason: string; message: string } | null = null;
    try {
      profile = await this.auth.joinOrg();
    } catch (err) {
      if (!(err instanceof JoinError)) throw err;
      joinError = { reason: err.reason, message: err.message };
    }
    await this.store.run(async () => {
      this.store.meta.profile = profile;
      this.store.meta.profileUid = profile ? user.uid : null;
      this.store.meta.joinError = joinError;
      await this.store.save('meta');
    });
    if (profile) await this.refreshOrgConfig(ORG_CONFIG_WAKE_REFRESH_MS).catch(logError('config/org'));
  }

  /**
   * Consent page: records `consentAcceptedAt` + `consentVersion` in
   * `users/{uid}` (the only fields the rules let the user write) and in the
   * cached profile.
   */
  async acceptConsent(version: string): Promise<void> {
    if (version !== CONSENT_VERSION) {
      throw new AuthError('consent-outdated', 'El aviso cambió. Cierra esta página y ábrela de nuevo desde la extensión.');
    }
    await this.auth.ready();
    const user = this.auth.currentUser();
    if (!user) throw new AuthError('signed-out', 'Inicia sesión primero desde el ícono de la extensión.');
    const profile = await this.store.run(() => (this.store.meta.profileUid === user.uid ? this.store.meta.profile : null));
    if (!profile) throw new AuthError('not-joined', 'Tu cuenta aún no está habilitada. Pide a tu administrador que te invite.');
    const at = Math.round(this.now());
    try {
      await this.backend.acceptConsent(user.uid, at, CONSENT_VERSION);
    } catch (err) {
      console.warn('[timetracking] consentimiento', err);
      throw new AuthError('consent-failed', 'No se pudo guardar tu aceptación. Revisa tu conexión y vuelve a intentarlo.');
    }
    await this.store.run(async () => {
      if (this.store.meta.profileUid !== user.uid || !this.store.meta.profile) return;
      this.store.meta.profile = { ...this.store.meta.profile, consentAcceptedAt: at, consentVersion: CONSENT_VERSION };
      await this.store.save('meta');
    });
  }

  /**
   * Signing out requires the work day to be closed. Blocks still held by the
   * accumulator are queued; pending uploads keep their uid and are sent when
   * that user signs in again (dropped if another user signs in).
   *
   * The accumulator itself is kept (it measures nothing without a work day):
   * if the same user signs in again and starts a work day inside the same
   * 10-minute block, that block keeps accumulating instead of restarting from
   * zero, which would replace the queued/uploaded snapshot with a smaller one.
   * Another user gets a fresh accumulator (see Tracker.beginMeasuring).
   */
  async signOut(): Promise<void> {
    await this.store.run(async () => {
      if (this.store.session) {
        throw new SessionError('session-open', 'Cierra tu jornada antes de cerrar sesión.');
      }
      const acc = this.store.acc;
      if (acc) {
        const { closed, current } = acc.flush(this.now());
        for (const slot of [...closed, ...(current ? [current] : [])]) {
          enqueueOp(this.store.queue, { kind: 'activity', uid: slot.uid, slot });
        }
        await this.store.save('queue');
      }
      this.store.meta.profile = null;
      this.store.meta.profileUid = null;
      this.store.meta.joinError = null;
      this.store.meta.org = null;
      await this.store.save('acc', 'meta');
    });
    await Promise.all([this.sync.kick(true), this.screenshots.drain(true)]).catch(() => undefined);
    await this.auth.signOut();
    await this.store.run(() => this.session.ensureAlarm());
  }

  async status(): Promise<StatusView> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    return this.store.run(() => {
      const { meta, session, queue, shots, daily } = this.store;
      const profile = user && meta.profileUid === user.uid ? meta.profile : null;
      const org = user && meta.org?.uid === user.uid ? meta.org : null;
      return {
        appEnv: __APP_ENV__,
        user: user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null,
        profile: profile
          ? { email: profile.email, displayName: profile.displayName, role: profile.role, status: profile.status }
          : null,
        joinError: user ? meta.joinError : null,
        consentRequired: profile !== null && profile.consentVersion !== CONSENT_VERSION,
        consentVersion: CONSENT_VERSION,
        session: session ? { id: session.id, startedAt: session.startedAt } : null,
        today: todayTotals(daily, user?.uid ?? null, this.now()),
        capture: org ? { screenshots: org.screenshotsEnabled, blur: org.blurScreenshots } : null,
        pendingOps: queue.items.length,
        pendingScreenshots: shots.items.length,
        lastSyncOkAt: meta.lastSyncOkAt,
        notice: meta.notice,
      };
    });
  }
}

function logError(what: string): (err: unknown) => void {
  return (err) => console.error(`[timetracking] error en ${what}`, err);
}
