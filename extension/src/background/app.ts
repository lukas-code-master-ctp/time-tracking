/**
 * Wires the background pieces together and registers every Chrome listener.
 * `register()` must run synchronously when the service worker starts (MV3
 * only delivers events to listeners added in the first turn of the script).
 *
 * The 30-second pulse (chrome.alarms) runs, in order: session pulse (blocks,
 * heartbeat, activity uploads) → `config/org` + schedule refresh when older
 * than 5 min → schedule tick → screenshot of the block if its random instant
 * passed → screenshot uploads.
 *
 * Working hours (spec 2026-09-30-horarios): `config/schedule` and
 * `schedules/{uid}` are read at the same moments as `config/org` and cached
 * in `tt.meta.schedule`; starting a work day reads the schedule first (with
 * a short timeout) so the pause applies from its first instant (see
 * `startWorkDay`). The "schedule tick" (every pulse, every wake-up and
 * the one-shot `SCHEDULE_ALARM` set at the next transition, reminder or
 * midnight) applies the pause of the measurement, shows the start/end
 * reminders (chrome.notifications, one per event and day) and re-arms the
 * alarm.
 */
import {
  CONSENT_VERSION,
  DEFAULT_TIME_ZONE,
  dateKey,
  readPersonSchedule,
  readScheduleConfig,
  type OrgConfig,
  type UserProfile,
} from '@timetracking/shared';
import {
  isContentMessage,
  isPopupRequest,
  type PopupRequest,
  type PopupResponse,
  type SignInResult,
  type StatusView,
} from '../messages';
import { AuthError, JoinError, withKeepAlive, type AuthService } from './auth';
import { todayTotals } from './daily';
import type { ImageProcessor } from './image';
import { enqueueOp } from './queue';
import type { Remote } from './remote';
import {
  SCHEDULE_ALARM,
  decideReminders,
  effectiveSchedule,
  nextScheduleWake,
  parseReminderNotificationId,
  reminderNotificationId,
  reminderText,
  scheduleView,
  type EffectiveSchedule,
  type Reminder,
} from './schedule';
import { ScreenshotManager, chromeCapturer, type Capturer } from './screenshots';
import { PULSE_ALARM, SessionError, SessionManager } from './session';
import type { StateStore, StorageAreaLike } from './state';
import { SyncEngine, errorCode } from './sync';
import { Tracker } from './tracker';

/** `config/org` is re-read at most this often from the pulse (spec: every 5 min). */
export const ORG_CONFIG_REFRESH_MS = 5 * 60_000;
/** …and when the worker wakes up, if older than this. */
export const ORG_CONFIG_WAKE_REFRESH_MS = 60_000;
/**
 * Starting a work day first re-reads the schedule (spec 2026-09-30-horarios,
 * revisión del e2e): it waits at most this long, then starts with the cached
 * one (offline, slow network) and the read applies when it arrives.
 */
export const START_SCHEDULE_TIMEOUT_MS = 3_000;
/** chrome.storage.session key of the last sign-in attempt (see {@link SignInResult}). */
export const SIGN_IN_RESULT_KEY = 'tt.signInResult';

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
  /** chrome.storage.session (null = unavailable: the sign-in result is not kept). */
  private readonly sessionArea: StorageAreaLike | null;
  /** Order of the schedule reads: an older read that answers late never overwrites a newer one. */
  private scheduleReads = 0;
  private scheduleWritten = 0;

  constructor(deps: AppDeps) {
    this.store = deps.store;
    this.auth = deps.auth;
    this.backend = deps.backend;
    this.now = deps.now ?? Date.now;
    this.sessionArea = deps.sessionArea !== undefined ? deps.sessionArea : (chrome.storage?.session ?? null);
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
      if (alarm.name === SCHEDULE_ALARM) void this.onScheduleAlarm().catch(logError('horario'));
    });
    chrome.notifications?.onButtonClicked.addListener(
      (id) => void this.onReminderAction(id).catch(logError('recordatorio')),
    );
    chrome.notifications?.onClicked.addListener((id) => void this.onReminderClicked(id).catch(logError('recordatorio')));
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
    await this.refreshConfig(ORG_CONFIG_WAKE_REFRESH_MS);
    await this.scheduleTick().catch(logError('horario'));
    void this.screenshots.drain().catch(logError('capturas'));
  }

  /** chrome.alarms pulse (every 30 s while there is something to do). */
  async pulse(opts: { forceScreenshot?: boolean } = {}): Promise<string> {
    await this.session.pulse();
    await this.refreshConfig(opts.forceScreenshot ? 0 : ORG_CONFIG_REFRESH_MS);
    await this.scheduleTick().catch(logError('horario'));
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

  /** `config/org` and the schedule, each when its cache is older than `maxAgeMs`; failures keep the cache. */
  async refreshConfig(maxAgeMs: number): Promise<void> {
    await Promise.all([
      this.refreshOrgConfig(maxAgeMs).catch(logError('config/org')),
      this.refreshSchedule(maxAgeMs).catch(logError('config/schedule')),
    ]);
  }

  /**
   * Reads `config/schedule` + `schedules/{uid}` when the cache is older than
   * `maxAgeMs` (0 = always), for a joined user. Invalid documents count as
   * missing (no schedule unless the other one defines the week). On failure
   * (offline…) the previous cache stays, so the pause keeps working offline.
   * A new schedule applies to the measurement right away.
   */
  async refreshSchedule(maxAgeMs: number): Promise<void> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    const due = await this.store.run(() => {
      const { profile, profileUid, schedule } = this.store.meta;
      if (!user || !profile || profileUid !== user.uid) return false;
      return !schedule || schedule.uid !== user.uid || this.now() - schedule.fetchedAt >= maxAgeMs;
    });
    if (!user || !due) return;
    const seq = ++this.scheduleReads;
    let raw: { config: unknown; person: unknown };
    try {
      raw = await this.backend.fetchSchedule(user.uid);
    } catch (err) {
      console.warn(`[timetracking] no se pudo leer el horario (${errorCode(err)})`);
      return;
    }
    const config = readScheduleConfig(raw.config);
    const person = readPersonSchedule(raw.person);
    if (raw.config != null && !config) console.warn('[timetracking] config/schedule no es válido: se ignora');
    if (raw.person != null && !person) console.warn('[timetracking] schedules/{uid} no es válido: se ignora');
    await this.store.run(async () => {
      if (this.store.meta.profileUid !== user.uid) return; // signed out meanwhile
      if (seq < this.scheduleWritten) return; // a newer read already answered
      this.scheduleWritten = seq;
      const at = this.now();
      this.store.meta.schedule = { uid: user.uid, config, person, fetchedAt: at };
      this.tracker.applySchedule(at);
      await this.store.save(...(this.store.acc ? (['acc', 'meta'] as const) : (['meta'] as const)));
    });
  }

  /**
   * "Iniciar jornada" (popup or reminder). The schedule is re-read BEFORE the
   * accumulator opens, so the pause is applied at the very instant of the
   * start: a schedule saved by the admin since the last read (the cache lives
   * up to 5 min) must not measure a single second outside the working hours.
   * The read waits at most START_SCHEDULE_TIMEOUT_MS; without an answer
   * (offline, slow network) the work day starts with the cached schedule and
   * the read applies when it arrives (from that instant: seconds already
   * attributed are not undone — see the spec, revisión del e2e).
   * `config/org` is read afterwards, as before (screenshots are not taken in
   * the first seconds anyway).
   */
  async startWorkDay(): Promise<void> {
    const schedule = this.refreshSchedule(0).catch(logError('config/schedule'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      schedule,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, START_SCHEDULE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    await this.session.start();
    void Promise.all([this.refreshOrgConfig(0).catch(logError('config/org')), schedule])
      .then(() => this.scheduleTick())
      .catch(logError('horario'));
  }

  /** Effective schedule of the signed-in, joined, active user (inside store.run). */
  private scheduleOf(uid: string | null | undefined): EffectiveSchedule | null {
    const { profile, profileUid, schedule } = this.store.meta;
    if (!uid || !profile || profileUid !== uid || profile.status !== 'active') return null;
    return effectiveSchedule(schedule, uid);
  }

  /**
   * Applies the pause at the current instant, shows the reminders due now
   * (only with `remindersEnabled`, a joined user and a working day that is
   * not a holiday; one per event and day) and re-arms `SCHEDULE_ALARM`.
   */
  async scheduleTick(): Promise<void> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    const notify = await this.store.run(async () => {
      const at = this.now();
      if (this.store.acc) {
        this.tracker.applySchedule(at);
        await this.store.save('acc');
      }
      const schedule = this.scheduleOf(user?.uid);
      const decision = decideReminders(schedule, at, this.store.session !== null, this.store.meta.reminders);
      if (decision.changed) {
        this.store.meta.reminders = decision.log;
        await this.store.save('meta');
      }
      await this.ensureScheduleAlarm(schedule, at);
      return decision.notify;
    });
    for (const r of notify) await this.showReminder(r);
  }

  /** One-shot alarm at a schedule transition, a reminder or midnight. */
  async onScheduleAlarm(): Promise<void> {
    await this.refreshConfig(ORG_CONFIG_REFRESH_MS);
    await this.scheduleTick();
  }

  /** `SCHEDULE_ALARM` at the next instant something changes (none without a schedule). */
  private async ensureScheduleAlarm(schedule: EffectiveSchedule | null, at: number): Promise<void> {
    const when = nextScheduleWake(schedule, at);
    try {
      if (when === null) {
        await chrome.alarms.clear(SCHEDULE_ALARM);
        return;
      }
      const existing = await chrome.alarms.get(SCHEDULE_ALARM);
      if (existing?.scheduledTime !== when) await chrome.alarms.create(SCHEDULE_ALARM, { when });
    } catch (err) {
      console.warn('[timetracking] no se pudo programar la alarma del horario', err);
    }
  }

  private async showReminder(r: Reminder): Promise<void> {
    const { message, button } = reminderText(r);
    try {
      await chrome.notifications.create(reminderNotificationId(r), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Registro de jornada',
        message,
        buttons: [{ title: button }],
        priority: 2,
        requireInteraction: true,
      });
    } catch (err) {
      console.warn('[timetracking] no se pudo mostrar el recordatorio', err);
    }
  }

  /**
   * Button of a reminder: "Iniciar jornada" starts the work day (the notice
   * must be accepted: otherwise it opens the notice) and "Cerrar jornada"
   * closes it. Any other problem, or a reminder of another day, opens the
   * popup, which explains it.
   */
  async onReminderAction(notificationId: string): Promise<void> {
    const reminder = parseReminderNotificationId(notificationId);
    if (!reminder) return;
    await chrome.notifications.clear(notificationId).catch(() => undefined);
    // A reminder of another day (left in the notification center) must not
    // start or close today's work day: the popup shows the current state.
    if (reminder.date !== dateKey(this.now(), DEFAULT_TIME_ZONE)) {
      await this.openPopup();
      return;
    }
    try {
      if (reminder.kind === 'start') {
        await this.startWorkDay();
      } else {
        await this.session.stop();
      }
    } catch (err) {
      const reason = err instanceof SessionError ? err.reason : '';
      // Already done from the popup meanwhile: nothing to do.
      if (reason === 'already-open' || reason === 'not-open') return;
      if (reason === 'consent-required') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('consent.html') });
        return;
      }
      await this.openPopup();
    }
  }

  /** Click on the body of a reminder: the popup. */
  async onReminderClicked(notificationId: string): Promise<void> {
    if (!parseReminderNotificationId(notificationId)) return;
    await chrome.notifications.clear(notificationId).catch(() => undefined);
    await this.openPopup();
  }

  /** The action popup (Chrome 127+); otherwise the same page in a tab. */
  private async openPopup(): Promise<void> {
    try {
      await chrome.action.openPopup();
    } catch {
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    }
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
          await this.startWorkDay();
          break;
        case 'session.stop':
          await this.session.stop();
          break;
        case 'auth.signIn':
          await this.signIn();
          break;
        case 'auth.clearSignInResult':
          await this.clearSignInResult(req.at);
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

  /**
   * "Iniciar sesión con Google": signInInteractive + joinOrg. The outcome is
   * kept in chrome.storage.session ({@link SIGN_IN_RESULT_KEY}) because
   * outside Chrome the popup closes when Google's window opens and never gets
   * this response; the reopened popup shows it (spec
   * 2026-10-01-login-otros-navegadores). A new attempt first drops the
   * previous result. The worker is kept alive while Google's window is open.
   */
  async signIn(): Promise<void> {
    await withKeepAlive(async () => {
      await this.saveSignInResult(null);
      try {
        const user = await this.auth.signInInteractive();
        await this.refreshProfile();
        const who = user.email ?? this.auth.currentUser()?.email;
        await this.saveSignInResult({ ok: true, message: who ? `Sesión iniciada como ${who}.` : 'Sesión iniciada.' });
      } catch (err) {
        // AuthError messages are already Spanish (and never carry a token).
        const message =
          err instanceof AuthError || err instanceof JoinError || err instanceof SessionError
            ? err.message
            : `No se pudo iniciar sesión. Inténtalo de nuevo (${err instanceof Error ? err.message : String(err)}).`;
        await this.saveSignInResult({ ok: false, message });
        throw err;
      }
    });
  }

  private async saveSignInResult(result: Omit<SignInResult, 'at'> | null): Promise<void> {
    if (!this.sessionArea) return;
    try {
      if (result) await this.sessionArea.set({ [SIGN_IN_RESULT_KEY]: { at: this.now(), ...result } satisfies SignInResult });
      else await this.sessionArea.remove(SIGN_IN_RESULT_KEY);
    } catch (err) {
      console.warn('[timetracking] resultado del inicio de sesión', err);
    }
  }

  async readSignInResult(): Promise<SignInResult | null> {
    if (!this.sessionArea) return null;
    try {
      const v = (await this.sessionArea.get(SIGN_IN_RESULT_KEY))[SIGN_IN_RESULT_KEY] as Partial<SignInResult> | undefined;
      if (!v || typeof v.at !== 'number' || typeof v.ok !== 'boolean' || typeof v.message !== 'string') return null;
      return { at: v.at, ok: v.ok, message: v.message };
    } catch {
      return null;
    }
  }

  /** The popup showed the result `at`; a newer attempt's result is kept. */
  async clearSignInResult(at: number): Promise<void> {
    const current = await this.readSignInResult();
    if (current && current.at === at) await this.saveSignInResult(null);
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
    if (profile) {
      await this.refreshConfig(ORG_CONFIG_WAKE_REFRESH_MS);
      await this.scheduleTick().catch(logError('horario'));
    }
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
      this.store.meta.schedule = null;
      this.store.meta.reminders = null;
      await this.store.save('acc', 'meta');
      await this.ensureScheduleAlarm(null, this.now());
    });
    await Promise.all([this.sync.kick(true), this.screenshots.drain(true)]).catch(() => undefined);
    await this.auth.signOut();
    await this.saveSignInResult(null);
    await this.store.run(() => this.session.ensureAlarm());
  }

  async status(): Promise<StatusView> {
    await this.auth.ready();
    const user = this.auth.currentUser();
    const signInResult = await this.readSignInResult();
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
        schedule: profile ? scheduleView(this.scheduleOf(user?.uid), this.now()) : null,
        pendingOps: queue.items.length,
        pendingScreenshots: shots.items.length,
        lastSyncOkAt: meta.lastSyncOkAt,
        notice: meta.notice,
        signInResult,
      };
    });
  }
}

function logError(what: string): (err: unknown) => void {
  return (err) => console.error(`[timetracking] error en ${what}`, err);
}
