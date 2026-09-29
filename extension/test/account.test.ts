import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_VERSION, SLOT_MS, dateKey, slotStartOf, type ActivitySlot } from '@timetracking/shared';
import {
  AuthError,
  JoinError,
  firebaseSignInError,
  googleSignIn,
  identityError,
  joinErrorMessage,
  type GoogleSignInDeps,
} from '../src/background/auth';
import { dailyFromJSON, recordSlots, todayTotals } from '../src/background/daily';
import { blurRadiusFor, encodeUnderLimit, fitWidth, supportsFilter } from '../src/background/image';
import { SIGNED_OUT_NOTICE } from '../src/background/session';
import { STORAGE_KEYS } from '../src/background/state';
import { PROFILE, activity, createHarness, hello, type Harness } from './fakes';

const SLOT0 = slotStartOf(1_790_000_000_000) + SLOT_MS;

describe('joinOrg rejections → clear Spanish messages', () => {
  it('maps every details.reason', () => {
    expect(joinErrorMessage('no-invitation')).toMatch(/Pide a tu administrador que te invite/);
    expect(joinErrorMessage('invitation-revoked')).toMatch(/revocada/);
    expect(joinErrorMessage('domain-not-allowed', ['empresa.cl'])).toContain('Usa tu cuenta @empresa.cl (');
    expect(joinErrorMessage('domain-not-allowed', ['impulseai.cl', 'compratuparcela.cl'])).toContain(
      'Usa tu cuenta @impulseai.cl o @compratuparcela.cl (',
    );
    // Default: the build list (empty in tests → shared defaults).
    expect(joinErrorMessage('domain-not-allowed')).toContain('@impulseai.cl o @compratuparcela.cl');
    expect(joinErrorMessage('user-disabled')).toMatch(/desactivada/);
    expect(joinErrorMessage('email-not-verified')).toMatch(/no está verificado/);
    expect(joinErrorMessage('unavailable')).toMatch(/Revisa tu conexión/);
    expect(joinErrorMessage('internal')).toMatch(/Reintentar/);
  });

  it('the popup gets the reason and message; start is refused until joined', async () => {
    const h = await createHarness({ joined: false });
    h.auth.joinResult = new JoinError('domain-not-allowed', joinErrorMessage('domain-not-allowed'));
    const res = await h.app.handlePopup({ type: 'auth.refreshProfile' });
    expect(res.ok && res.status.joinError).toEqual({ reason: 'domain-not-allowed', message: joinErrorMessage('domain-not-allowed') });
    expect(res.ok && res.status.profile).toBeNull();
    expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: false, reason: 'not-joined' });
  });
});

describe('Google sign-in (chrome.identity → Firebase)', () => {
  function deps(overrides: Partial<GoogleSignInDeps> & { tokens?: string[] } = {}) {
    const tokens = overrides.tokens ?? ['t1', 't2'];
    const removed: string[] = [];
    const used: string[] = [];
    const d: GoogleSignInDeps = {
      getAuthToken: async () => tokens.shift() ?? '',
      removeCachedAuthToken: async (t) => {
        removed.push(t);
      },
      signInWithToken: async (t) => {
        used.push(t);
        return { uid: 'g1', email: 'ana@compratuparcela.cl', displayName: 'Ana' };
      },
      ...overrides,
    };
    return { d, removed, used };
  }

  it('signs in with the access token', async () => {
    const { d, used, removed } = deps();
    await expect(googleSignIn(d)).resolves.toMatchObject({ uid: 'g1' });
    expect(used).toEqual(['t1']);
    expect(removed).toEqual([]);
  });

  it('an invalid cached token is removed and the flow retried once', async () => {
    const used: string[] = [];
    const { d, removed } = deps({
      signInWithToken: async (t) => {
        used.push(t);
        if (t === 't1') throw Object.assign(new Error('bad'), { code: 'auth/invalid-credential' });
        return { uid: 'g1', email: null, displayName: null };
      },
    });
    await expect(googleSignIn(d)).resolves.toMatchObject({ uid: 'g1' });
    expect(used).toEqual(['t1', 't2']);
    expect(removed).toEqual(['t1']);
  });

  it('gives up after the second invalid token', async () => {
    const { d, removed } = deps({
      signInWithToken: async () => {
        throw Object.assign(new Error('bad'), { code: 'auth/invalid-credential' });
      },
    });
    await expect(googleSignIn(d)).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(removed).toEqual(['t1', 't2']);
  });

  it('user cancelling the Google dialog → "cancelled"; other failures explained', async () => {
    const { d } = deps({
      getAuthToken: async () => {
        throw new Error('The user did not approve access.');
      },
    });
    await expect(googleSignIn(d)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(identityError(new Error('Invalid OAuth2 Client ID.')).reason).toBe('oauth-config');
    expect(identityError(new Error("OAuth2 request failed: Service responded with error: 'bad client id: x'")).reason).toBe('oauth-config');
    // Access not granted / revoked by the user is not a configuration problem.
    expect(identityError(new Error('OAuth2 not granted or revoked.')).reason).toBe('cancelled');
    expect(identityError(new Error('The user is not signed in.')).reason).toBe('chrome-signed-out');
    expect(identityError(new Error('boom')).reason).toBe('identity-failed');
    expect(firebaseSignInError({ code: 'auth/network-request-failed' }).reason).toBe('network');
    expect(firebaseSignInError({ code: 'auth/user-disabled' }).reason).toBe('user-disabled');
    const { d: net } = deps({
      signInWithToken: async () => {
        throw Object.assign(new Error('x'), { code: 'auth/network-request-failed' });
      },
    });
    const err = await googleSignIn(net).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toMatch(/Sin conexión/);
  });
});

describe('consent (spec 4)', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
    h = await createHarness({ joined: false });
    const { consentAcceptedAt: _a, consentVersion: _v, ...noConsent } = PROFILE;
    h.auth.joinResult = noConsent;
    await h.app.refreshProfile();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start is refused until the current notice is accepted; accepting writes both fields and unlocks it', async () => {
    const status = await h.app.status();
    expect(status.consentRequired).toBe(true);
    expect(status.consentVersion).toBe(CONSENT_VERSION);
    expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: false, reason: 'consent-required' });
    expect(h.app.store.session).toBeNull();

    const res = await h.app.handlePopup({ type: 'consent.accept', version: CONSENT_VERSION });
    expect(res.ok && res.status.consentRequired).toBe(false);
    expect(h.backend.ops('acceptConsent')).toEqual([
      { op: 'acceptConsent', uid: 'u1', at: SLOT0 + 60_000, version: CONSENT_VERSION },
    ]);
    expect(h.chrome.local.data[STORAGE_KEYS.meta]).toMatchObject({ profile: { consentVersion: CONSENT_VERSION } });
    expect(await h.app.handlePopup({ type: 'session.start' })).toMatchObject({ ok: true });
  });

  it('an older accepted version is not enough', async () => {
    h.app.store.meta.profile = { ...h.app.store.meta.profile!, consentVersion: '2020-01-01', consentAcceptedAt: 1 };
    expect((await h.app.status()).consentRequired).toBe(true);
    await expect(h.app.session.start()).rejects.toMatchObject({ reason: 'consent-required' });
  });

  it('refuses a stale page version, a signed-out user and reports offline failures', async () => {
    expect(await h.app.handlePopup({ type: 'consent.accept', version: 'vieja' })).toMatchObject({ ok: false, reason: 'consent-outdated' });
    h.backend.offline = true;
    const off = await h.app.handlePopup({ type: 'consent.accept', version: CONSENT_VERSION });
    expect(off).toMatchObject({ ok: false, reason: 'consent-failed' });
    expect((await h.app.status()).consentRequired).toBe(true);
    h.backend.offline = false;
    h.auth.user = null;
    expect(await h.app.handlePopup({ type: 'consent.accept', version: CONSENT_VERSION })).toMatchObject({ ok: false, reason: 'signed-out' });
  });
});

describe('Firebase session ends while the work day is open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SLOT0 + 60_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onAuthStateChanged(null) closes it locally and queues the close; it is sent if the same user signs in again', async () => {
    const h = await createHarness();
    await hello(h, 11);
    await h.app.session.start();
    await h.settle();
    const id = h.app.store.session!.id;
    await vi.advanceTimersByTimeAsync(20_000);

    h.backend.uid = null;
    h.auth.setUser(null);
    await h.settle();
    expect(h.app.store.session).toBeNull();
    expect(h.app.store.meta.notice).toBe(SIGNED_OUT_NOTICE);
    expect(h.chrome.world.badgeText).toBe('');
    // Waiting for the user (unauthenticated = retry), not dropped.
    expect(h.app.store.queue.items.map((i) => i.key)).toContain(`close:${id}`);
    expect(h.backend.ops('closeSession')).toHaveLength(0);

    h.backend.uid = 'u1';
    h.auth.setUser({ uid: 'u1', email: 'ana@compratuparcela.cl', displayName: 'ana' });
    await h.app.handlePopup({ type: 'sync.now' });
    await h.settle();
    expect(h.backend.ops('closeSession')).toEqual([{ op: 'closeSession', sessionId: id, endedAt: SLOT0 + 80_000 }]);
  });

  it('another user signing in: the work day is closed and its operations are never sent with that account', async () => {
    const h = await createHarness();
    await h.app.session.start();
    await h.settle();
    h.backend.uid = 'u2';
    h.auth.setUser({ uid: 'u2', email: 'otro@compratuparcela.cl', displayName: null });
    await h.settle();
    expect(h.app.store.session).toBeNull();
    expect(h.backend.ops('closeSession')).toHaveLength(0);
    expect(h.app.store.queue.items).toEqual([]);
  });
});

describe('today summary (local, for the popup)', () => {
  const slot = (slotStart: number, tracked: number, active: number, uid = 'u1'): ActivitySlot => ({
    uid,
    sessionId: 's',
    slotStart,
    trackedSeconds: tracked,
    activeSeconds: active,
    outsideChromeSeconds: 0,
    domains: {},
    urls: [],
  });

  it('newest snapshot of a block wins; sums the day; resets on a new day or another user', () => {
    let d = recordSlots(null, [slot(SLOT0, 60, 30)]);
    d = recordSlots(d, [slot(SLOT0, 120, 90), slot(SLOT0 + SLOT_MS, 600, 700)]);
    expect(todayTotals(d, 'u1', SLOT0 + SLOT_MS)).toEqual({ trackedSeconds: 720, activeSeconds: 690 });
    expect(todayTotals(d, 'u2', SLOT0)).toEqual({ trackedSeconds: 0, activeSeconds: 0 });
    const tomorrow = SLOT0 + 24 * 3600_000;
    expect(todayTotals(d, 'u1', tomorrow)).toEqual({ trackedSeconds: 0, activeSeconds: 0 });
    const d2 = recordSlots(d, [slot(tomorrow, 10, 5)]);
    expect(d2?.date).toBe(dateKey(tomorrow));
    expect(todayTotals(d2, 'u1', tomorrow)).toEqual({ trackedSeconds: 10, activeSeconds: 5 });
    // A late snapshot of yesterday does not reset today.
    expect(todayTotals(recordSlots(d2, [slot(SLOT0, 1, 1)]), 'u1', tomorrow).trackedSeconds).toBe(10);
    expect(recordSlots(d2, [slot(tomorrow, 5, 5, 'u2')])?.uid).toBe('u2');
    expect(dailyFromJSON(JSON.parse(JSON.stringify(d2)))).toEqual(d2);
    expect(dailyFromJSON({ uid: 1 })).toBeNull();
  });

  it('is fed by the pulse and the close of the work day, and shown in the status', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(SLOT0 + 60_000);
      const h = await createHarness();
      await hello(h, 11);
      await h.app.session.start();
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(15_000);
        await activity(h, 11);
        await vi.advanceTimersByTimeAsync(15_000);
        await h.app.pulse();
      }
      const mid = await h.app.status();
      expect(mid.today.trackedSeconds).toBe(120);
      expect(mid.today.activeSeconds).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await h.app.session.stop();
      expect((await h.app.status()).today.trackedSeconds).toBe(130);
      expect(h.chrome.local.data[STORAGE_KEYS.daily]).toMatchObject({ uid: 'u1', date: dateKey(SLOT0) });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('image helpers (the canvas part runs in the e2e)', () => {
  it('fits to 1280 px wide keeping the aspect ratio', () => {
    expect(fitWidth(2560, 1440)).toEqual({ width: 1280, height: 720 });
    expect(fitWidth(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWidth(3000, 1)).toEqual({ width: 1280, height: 1 });
    expect(blurRadiusFor(1280)).toBe(13);
    expect(blurRadiusFor(100)).toBe(6);
  });

  it('lowers the quality, then the size, until the JPEG is strictly below the limit', async () => {
    const calls: [number, number][] = [];
    const encode = async (scale: number, quality: number) => {
      calls.push([scale, quality]);
      return new Blob([new Uint8Array(Math.round(2_000 * scale * scale * quality))]);
    };
    const r = await encodeUnderLimit(encode, 400);
    expect(r.blob.size).toBeLessThan(400);
    expect(calls[0]).toEqual([1, 0.7]);
    expect(r.scale).toBeLessThan(1);
    // Fits at once: a single encode.
    calls.length = 0;
    await encodeUnderLimit(encode, 10_000);
    expect(calls).toHaveLength(1);
    await expect(encodeUnderLimit(async () => new Blob([new Uint8Array(10)]), 5)).rejects.toThrow();
  });

  it('detects whether the 2D context applies filters', () => {
    const real = { filter: 'none' };
    expect(supportsFilter(real)).toBe(true);
    expect(real.filter).toBe('none');
    const ignoring = {
      get filter() {
        return 'none';
      },
      set filter(_v: string) {},
    };
    expect(supportsFilter(ignoring)).toBe(false);
    expect(supportsFilter({})).toBe(false);
  });
});
