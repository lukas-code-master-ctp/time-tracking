/**
 * Wires the background pieces together and registers every Chrome listener.
 * `register()` must run synchronously when the service worker starts (MV3
 * only delivers events to listeners added in the first turn of the script).
 */
import type { UserProfile } from '@timetracking/shared';
import {
  isContentMessage,
  isPopupRequest,
  type PopupRequest,
  type PopupResponse,
  type StatusView,
} from '../messages';
import { AuthError, JoinError, type AuthService } from './auth';
import { enqueueOp } from './queue';
import { PULSE_ALARM, SessionError, SessionManager } from './session';
import type { StateStore, StorageAreaLike } from './state';
import { SyncEngine, type Backend } from './sync';
import { Tracker } from './tracker';

export interface AppDeps {
  store: StateStore;
  backend: Backend;
  auth: AuthService;
  now?: () => number;
  sessionArea?: StorageAreaLike | null;
}

export class App {
  readonly store: StateStore;
  readonly auth: AuthService;
  readonly tracker: Tracker;
  readonly sync: SyncEngine;
  readonly session: SessionManager;
  private readonly now: () => number;

  constructor(deps: AppDeps) {
    this.store = deps.store;
    this.auth = deps.auth;
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
  }

  register(): void {
    this.tracker.register();
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === PULSE_ALARM) void this.session.pulse().catch(logError('pulso'));
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
    // Back online: retry the queue without waiting for the backoff.
    globalThis.addEventListener?.('online', () => void this.sync.kick(true));
  }

  /** Every service-worker start. */
  start(): Promise<void> {
    return this.session.rehydrate().catch(logError('rehidratación'));
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
      switch (req.type) {
        case 'status':
          break;
        case 'session.start':
          await this.session.start();
          break;
        case 'session.stop':
          await this.session.stop();
          break;
        case 'auth.devSignIn':
          await this.auth.signInDev(req.email);
          await this.refreshProfile();
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
        case 'sync.now':
          await this.sync.kick(true);
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
      await this.store.save('acc', 'meta');
    });
    await this.sync.kick(true).catch(() => undefined);
    await this.auth.signOut();
    await this.store.run(() => this.session.ensureAlarm());
  }

  async status(): Promise<StatusView> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    return this.store.run(() => {
      const { meta, session, queue } = this.store;
      const profile = user && meta.profileUid === user.uid ? meta.profile : null;
      return {
        appEnv: __APP_ENV__,
        user: user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null,
        profile: profile
          ? { email: profile.email, displayName: profile.displayName, role: profile.role, status: profile.status }
          : null,
        joinError: user ? meta.joinError : null,
        session: session ? { id: session.id, startedAt: session.startedAt } : null,
        pendingOps: queue.items.length,
        lastSyncOkAt: meta.lastSyncOkAt,
        notice: meta.notice,
      };
    });
  }
}

function logError(what: string): (err: unknown) => void {
  return (err) => console.error(`[timetracking] error en ${what}`, err);
}
