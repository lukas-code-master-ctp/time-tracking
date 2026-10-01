/**
 * Authentication of the extension (lives in the service worker; the popup
 * only sends messages).
 *
 * - Dev build: `signInDev(email)` signs in to the Auth emulator with a fake
 *   Google credential (`GoogleAuthProvider.credential(JSON.stringify({ sub,
 *   email, email_verified: true }))`, accepted only by the emulator).
 * - Prod build: `signInInteractive()`: `chrome.identity.getAuthToken({
 *   interactive: true })` (Google account of the Chrome profile, OAuth client
 *   "Chrome extension" in manifest.oauth2) → `GoogleAuthProvider.credential(
 *   null, accessToken)` → `signInWithCredential`. A token rejected by Firebase
 *   (revoked/expired in Chrome's cache) is removed with
 *   `removeCachedAuthToken` and the flow is retried once.
 * - Other Chromium browsers (Edge, Brave, Opera, Vivaldi, Arc) have no working
 *   `getAuthToken`: when it is missing or fails for any reason other than a
 *   user cancellation (not supported, no account in the profile, OAuth
 *   config…; see `FALLBACK_REASONS`) the sign-in falls back to
 *   `chrome.identity.launchWebAuthFlow` with Google's OpenID Connect implicit
 *   flow (`response_type=id_token`, random `nonce`, redirect URI
 *   `https://<id>.chromiumapp.org/`) using the web OAuth client of the
 *   Firebase Google provider (`VITE_GOOGLE_WEB_CLIENT_ID`) →
 *   `GoogleAuthProvider.credential(idToken)` → `signInWithCredential`. The
 *   `id_token` signature is NOT checked here: Firebase Auth verifies it
 *   (signature, issuer, audience = a client of the provider, expiry); we only
 *   decode its payload to match the `nonce` of this attempt. A user who
 *   cancels never gets the other method.
 * - After signing in, `joinOrg()` calls the callable of the same name, which
 *   creates `users/{uid}` or rejects with `details.reason` (no invitation,
 *   domain not allowed…), mapped to clear Spanish messages here.
 * - Signing out also drops Chrome's cached token (only where `getAuthToken`
 *   exists; the web flow caches nothing: Firebase keeps its own session).
 */
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut as fbSignOut,
  type Auth,
  type User,
} from 'firebase/auth/web-extension';
import { httpsCallable, type Functions } from 'firebase/functions';
import { emailKey, formatDomains, type UserProfile } from '@timetracking/shared';
import { hasGetAuthToken, isGoogleChrome } from '../browser';
import { ALLOWED_DOMAINS, BUILD_CONFIG } from '../env';

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export interface AuthService {
  /** Resolves once the persisted user (if any) has been restored. */
  ready(): Promise<void>;
  /** Signed-in user (valid after `ready()`). */
  currentUser(): AuthUser | null;
  /** Dev build only (Auth emulator). Rejects in prod builds. */
  signInDev(email: string): Promise<AuthUser>;
  /** Google sign-in with chrome.identity (getAuthToken or launchWebAuthFlow). Throws {@link AuthError}. */
  signInInteractive(): Promise<AuthUser>;
  signOut(): Promise<void>;
  /** Called whenever the signed-in user changes (also when Firebase drops the session). */
  onChange(cb: (user: AuthUser | null) => void): void;
  /** Calls the `joinOrg` callable. Throws {@link JoinError}. */
  joinOrg(): Promise<UserProfile>;
}

/** joinOrg rejection with the machine-readable reason of the HttpsError. */
export class JoinError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'JoinError';
  }
}

export class AuthError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    /** Original technical message (chrome.identity), kept for diagnosis. */
    readonly detail = '',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function toAuthUser(u: User | null): AuthUser | null {
  return u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null;
}

/** Token accepted by the Auth emulator as a Google ID token (dev only). */
export function devGoogleIdToken(email: string): string {
  const e = emailKey(email);
  const local = e.slice(0, e.indexOf('@'));
  return JSON.stringify({
    sub: `dev-${e.replace(/[^a-z0-9]/g, '-')}`,
    email: e,
    email_verified: true,
    name: local,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Clear Spanish message for each `joinOrg` rejection (`details.reason`). */
export function joinErrorMessage(reason: string, domains: readonly string[] = ALLOWED_DOMAINS): string {
  switch (reason) {
    case 'no-invitation':
      return 'Aún no tienes una invitación. Pide a tu administrador que te invite y luego pulsa “Reintentar”.';
    case 'invitation-revoked':
      return 'Tu invitación fue revocada. Pide a tu administrador que te invite de nuevo.';
    case 'domain-not-allowed':
      return `Esta cuenta no es de la empresa. Usa tu cuenta ${formatDomains(domains)} (la cuenta Google con la que iniciaste sesión).`;
    case 'user-disabled':
      return 'Tu cuenta está desactivada. Habla con tu administrador.';
    case 'email-not-verified':
      return 'Tu correo no está verificado. Inicia sesión con tu cuenta Google de la empresa.';
    case 'no-email':
      return 'Tu cuenta de Google no tiene un correo asociado. Usa tu cuenta de la empresa.';
    case 'unauthenticated':
      return 'Tu sesión expiró. Vuelve a iniciar sesión.';
    default:
      return 'No se pudo validar tu cuenta con el servidor. Revisa tu conexión y pulsa “Reintentar”.';
  }
}

/** chrome.identity / Firebase pieces used by {@link googleSignIn} (faked in tests). */
export interface GoogleSignInDeps {
  getAuthToken(interactive: boolean): Promise<string>;
  removeCachedAuthToken(token: string): Promise<void>;
  signInWithToken(accessToken: string): Promise<AuthUser>;
}

/** Firebase errors that mean "this Google token is no good": drop it and ask Chrome for a new one. */
const BAD_TOKEN_CODES = new Set(['auth/invalid-credential', 'auth/invalid-idp-response', 'auth/user-token-expired']);

function codeOf(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

const CANCELLED_MESSAGE = 'Se canceló el inicio de sesión. Pulsa “Iniciar sesión con Google” para intentarlo de nuevo.';

/**
 * `getAuthToken` failures that mean "this browser has no Chrome sign-in", so
 * the web flow is used instead. Known messages:
 * - Edge: "This API is not supported on Microsoft Edge." (older versions:
 *   "OAuth2 request failed: Connection failed (-2).");
 * - Brave: "The user turned off browser signin" (Chromium's message when
 *   browser sign-in is disabled; also a Chrome user who disabled it, for whom
 *   the web flow works too);
 * - any "… is not available / unsupported / not implemented".
 */
export function isUnsupportedIdentityError(err: unknown): boolean {
  return /not supported|unsupported|is not available|not implemented|turned off browser sign-?in|connection failed \(-2\)/i.test(
    messageOf(err),
  );
}

/** chrome.identity rejection → AuthError (cancelled vs failure). */
export function identityError(err: unknown): AuthError {
  const msg = messageOf(err);
  // Checked first: Edge's old message starts with "OAuth2 request failed".
  if (isUnsupportedIdentityError(err)) {
    return new AuthError('unsupported', `Este navegador no permite el inicio de sesión de Chrome (${msg}).`, msg);
  }
  // "The user is not signed in.": the Chrome profile has no Google account
  // (getAuthToken always uses the profile's primary account).
  if (/not signed in/i.test(msg)) {
    return new AuthError(
      'chrome-signed-out',
      'Chrome no tiene una cuenta Google iniciada. Inicia sesión en Chrome con tu cuenta de la empresa (ícono de perfil, arriba a la derecha) y vuelve a intentarlo.',
      msg,
    );
  }
  if (/did not approve|not granted|revoked|canceled|cancelled|user interaction required|closed/i.test(msg)) {
    return new AuthError('cancelled', CANCELLED_MESSAGE, msg);
  }
  if (/oauth2|client id|bad client/i.test(msg)) {
    return new AuthError(
      'oauth-config',
      `La extensión no tiene configurado el inicio de sesión con Google. Avisa a tu administrador (${msg}).`,
      msg,
    );
  }
  return new AuthError('identity-failed', `No se pudo iniciar sesión con Google (${msg || 'error desconocido'}).`, msg);
}

/** Firebase signInWithCredential rejection (other than a bad token) → AuthError. */
export function firebaseSignInError(err: unknown): AuthError {
  const code = codeOf(err);
  if (code === 'auth/network-request-failed') {
    return new AuthError('network', 'Sin conexión con el servidor. Revisa tu internet y reintenta.');
  }
  if (code === 'auth/user-disabled') {
    return new AuthError('user-disabled', 'Tu cuenta está desactivada. Habla con tu administrador.');
  }
  return new AuthError('sign-in-failed', `No se pudo iniciar sesión (${code || messageOf(err)}).`);
}

/**
 * getAuthToken → signInWithCredential; on a rejected token, remove it from
 * Chrome's cache and retry once with a fresh one.
 */
export async function googleSignIn(deps: GoogleSignInDeps): Promise<AuthUser> {
  for (let attempt = 0; ; attempt++) {
    let token: string;
    try {
      token = await deps.getAuthToken(true);
    } catch (err) {
      throw identityError(err);
    }
    // Chrome rejects on a cancellation; an empty token without an error only
    // comes from a browser whose getAuthToken does not really work, so it is
    // NOT a cancellation (signInWithBestMethod falls back to the web flow).
    if (!token) {
      const detail = 'getAuthToken no devolvió un token';
      throw new AuthError('identity-failed', `No se pudo iniciar sesión con Google (${detail}).`, detail);
    }
    try {
      return await deps.signInWithToken(token);
    } catch (err) {
      if (!BAD_TOKEN_CODES.has(codeOf(err))) throw firebaseSignInError(err);
      await deps.removeCachedAuthToken(token).catch(() => undefined);
      if (attempt >= 1) {
        throw new AuthError('invalid-token', 'Google rechazó el acceso. Cierra y vuelve a abrir Chrome e inténtalo de nuevo.');
      }
    }
  }
}

// ---------- launchWebAuthFlow (Edge, Brave, Opera, Vivaldi, Arc) ----------

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export const UNSUPPORTED_BROWSER_MESSAGE = 'Este navegador no es compatible todavía: usa Google Chrome.';

/** chrome.identity / Firebase pieces used by {@link webAuthFlowSignIn} (faked in tests). */
export interface WebAuthFlowDeps {
  /** Web OAuth client of the Firebase Google provider (`VITE_GOOGLE_WEB_CLIENT_ID`); empty = not configured. */
  clientId: string;
  /** `chrome.identity.getRedirectURL()` → `https://<extension-id>.chromiumapp.org/`. */
  redirectUri(): string;
  /** Allowed Workspace domains: `hd` is sent only when there is exactly one. */
  domains: readonly string[];
  /** Fresh random value per attempt. */
  nonce(): string;
  /** `chrome.identity.launchWebAuthFlow({ url, interactive: true })`; resolves to the final redirect URL. */
  launchWebAuthFlow(url: string): Promise<string | undefined>;
  signInWithIdToken(idToken: string): Promise<AuthUser>;
}

/** Google's authorization URL for the OpenID Connect implicit flow (`id_token` only). */
export function webAuthUrl(p: { clientId: string; redirectUri: string; nonce: string; domains: readonly string[] }): string {
  const params = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'id_token',
    redirect_uri: p.redirectUri,
    scope: 'openid email profile',
    nonce: p.nonce,
    prompt: 'select_account',
  });
  // `hd` only pre-filters Google's account chooser; joinOrg is the real check.
  if (p.domains.length === 1) params.set('hd', p.domains[0] as string);
  // URLSearchParams encodes spaces as "+"; %20 is the documented form.
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString().replace(/\+/g, '%20')}`;
}

/** 128 random bits (hex) from the Web Crypto API. */
export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Payload of a JWT, decoded WITHOUT checking the signature (Firebase checks
 * it in signInWithCredential). Null when it is not a readable JWT.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bin = atob(b64);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const payload: unknown = JSON.parse(json);
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Final redirect URL of the web flow → `id_token` of this attempt. Google puts
 * the result in the fragment (`#id_token=…` / `#error=…`); errors may also
 * come in the query string.
 */
export function idTokenFromRedirect(responseUrl: string, nonce: string): string {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new AuthError('web-auth-failed', 'Google devolvió una respuesta inválida. Inténtalo de nuevo.');
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const error = fragment.get('error') ?? url.searchParams.get('error');
  if (error) {
    if (error === 'access_denied') throw new AuthError('cancelled', CANCELLED_MESSAGE);
    const description = fragment.get('error_description') ?? url.searchParams.get('error_description');
    throw new AuthError('web-auth-failed', `Google no permitió iniciar sesión (${description ? `${error}: ${description}` : error}).`);
  }
  const idToken = fragment.get('id_token');
  if (!idToken) throw new AuthError('no-id-token', 'Google no devolvió la identidad de tu cuenta. Inténtalo de nuevo.');
  if (decodeJwtPayload(idToken)?.nonce !== nonce) {
    throw new AuthError('nonce-mismatch', 'La respuesta de Google no corresponde a este inicio de sesión. Inténtalo de nuevo.');
  }
  return idToken;
}

/** launchWebAuthFlow → id_token (nonce checked) → signInWithCredential. */
export async function webAuthFlowSignIn(deps: WebAuthFlowDeps): Promise<AuthUser> {
  if (!deps.clientId) throw new AuthError('unsupported-browser', UNSUPPORTED_BROWSER_MESSAGE);
  const nonce = deps.nonce();
  let redirect: string | undefined;
  try {
    // getRedirectURL inside the try: a browser where it throws gets a clear
    // AuthError instead of a raw TypeError.
    redirect = await deps.launchWebAuthFlow(webAuthUrl({ clientId: deps.clientId, redirectUri: deps.redirectUri(), nonce, domains: deps.domains }));
  } catch (err) {
    // Window closed: "The user did not approve access." → cancelled.
    throw identityError(err);
  }
  if (!redirect) throw new AuthError('cancelled', CANCELLED_MESSAGE);
  const idToken = idTokenFromRedirect(redirect, nonce);
  try {
    return await deps.signInWithIdToken(idToken);
  } catch (err) {
    if (BAD_TOKEN_CODES.has(codeOf(err))) {
      throw new AuthError('invalid-token', 'Google rechazó el acceso. Inténtalo de nuevo; si sigue fallando, avisa a tu administrador.');
    }
    throw firebaseSignInError(err);
  }
}

/** Both sign-in methods; `chrome` is null where `getAuthToken` does not exist. */
export interface SignInMethods {
  chrome: GoogleSignInDeps | null;
  web: WebAuthFlowDeps;
  /** Google Chrome itself (not Edge/Brave/Opera…), see `isGoogleChrome()`: picks the message when there is no web client. */
  isGoogleChrome: boolean;
}

/**
 * `getAuthToken` failures that move on to the web flow: everything except a
 * user cancellation — not supported (Edge, Brave), no Google account in the
 * browser profile (the user picks one in Google's window instead), OAuth
 * configuration ("Invalid OAuth2 Client ID", e.g. a package without
 * manifest.oauth2) and unknown chrome.identity errors. Errors after
 * getAuthToken succeeded (Firebase, network) are final.
 */
const FALLBACK_REASONS = new Set(['unsupported', 'chrome-signed-out', 'oauth-config', 'identity-failed']);

/** "<message> (getAuthToken: <technical text>)", to diagnose a failed fallback. */
function withChromeDetail(err: AuthError, chromeError: AuthError): AuthError {
  if (!chromeError.detail) return err;
  return new AuthError(err.reason, `${err.message.replace(/\.$/, '')} (getAuthToken: ${chromeError.detail}).`, chromeError.detail);
}

/**
 * Chrome: getAuthToken (unchanged when it works). When it does not exist or
 * fails for any reason other than a cancellation (see
 * {@link FALLBACK_REASONS}), the web flow is used. A cancellation in either
 * method is final: the other one is not tried. If the fallback also fails,
 * the message carries getAuthToken's original text in parentheses.
 */
export async function signInWithBestMethod(m: SignInMethods): Promise<AuthUser> {
  let chromeError: AuthError | null = null;
  if (m.chrome) {
    try {
      return await googleSignIn(m.chrome);
    } catch (err) {
      if (!(err instanceof AuthError) || !FALLBACK_REASONS.has(err.reason)) throw err;
      chromeError = err;
    }
  }
  if (chromeError && !m.web.clientId && m.isGoogleChrome) {
    // Without the web client there is nothing to fall back to: in Google
    // Chrome, Chrome's own message (sign in to Chrome, OAuth config…) is the
    // useful one, not "use Google Chrome".
    throw chromeError.message.includes(chromeError.detail) ? chromeError : withChromeDetail(chromeError, chromeError);
  }
  try {
    return await webAuthFlowSignIn(m.web);
  } catch (err) {
    if (chromeError && err instanceof AuthError && err.reason !== 'cancelled') throw withChromeDetail(err, chromeError);
    throw err;
  }
}

/** Interval of {@link withKeepAlive}: below the 30 s idle limit of an MV3 service worker. */
export const KEEP_ALIVE_MS = 20_000;

/**
 * Runs `task` while calling a trivial extension API every
 * {@link KEEP_ALIVE_MS}: an MV3 service worker is stopped after 30 s without
 * events or API calls, and a pending `launchWebAuthFlow` / `getAuthToken`
 * (the user choosing an account, typing a password, 2-step verification…)
 * does not count. The popup closes when Google's window opens, so nothing
 * else keeps the worker alive until the result is saved.
 */
export async function withKeepAlive<T>(
  task: () => Promise<T>,
  ping: () => unknown = () => chrome.runtime.getPlatformInfo?.(),
  intervalMs = KEEP_ALIVE_MS,
): Promise<T> {
  const timer = setInterval(() => {
    try {
      void Promise.resolve(ping()).catch(() => undefined);
    } catch {
      // ping unavailable: nothing else to do
    }
  }, intervalMs);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

async function chromeAuthToken(interactive: boolean): Promise<string> {
  const res = (await chrome.identity.getAuthToken({ interactive })) as chrome.identity.GetAuthTokenResult | string | undefined;
  return typeof res === 'string' ? res : (res?.token ?? '');
}

/** Removes Chrome's cached Google token (sign-out). Never throws. */
export async function dropCachedGoogleToken(): Promise<void> {
  if (!hasGetAuthToken()) return;
  try {
    const token = await chromeAuthToken(false);
    if (token) await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    // no cached token (or identity unavailable): nothing to drop
  }
}

export function createFirebaseAuthService(auth: Auth, functions: Functions): AuthService {
  return {
    ready: () => auth.authStateReady(),
    currentUser: () => toAuthUser(auth.currentUser),

    async signInDev(email: string): Promise<AuthUser> {
      if (__APP_ENV__ !== 'dev') throw new AuthError('not-available', 'El inicio de sesión de desarrollo no existe en este build.');
      if (!EMAIL_RE.test(email.trim())) throw new AuthError('invalid-email', 'Escribe un correo válido.');
      const credential = GoogleAuthProvider.credential(devGoogleIdToken(email));
      const result = await signInWithCredential(auth, credential);
      return toAuthUser(result.user) as AuthUser;
    },

    signInInteractive(): Promise<AuthUser> {
      const signIn = async (credential: ReturnType<typeof GoogleAuthProvider.credential>): Promise<AuthUser> =>
        toAuthUser((await signInWithCredential(auth, credential)).user) as AuthUser;
      const hasWebFlow =
        typeof chrome.identity?.launchWebAuthFlow === 'function' && typeof chrome.identity?.getRedirectURL === 'function';
      return signInWithBestMethod({
        chrome: hasGetAuthToken()
          ? {
              getAuthToken: chromeAuthToken,
              removeCachedAuthToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
              signInWithToken: (accessToken) => signIn(GoogleAuthProvider.credential(null, accessToken)),
            }
          : null,
        web: {
          // Without launchWebAuthFlow there is no way to sign in: same message as a missing client ID.
          clientId: hasWebFlow ? BUILD_CONFIG.googleWebClientId : '',
          redirectUri: () => chrome.identity.getRedirectURL(),
          domains: ALLOWED_DOMAINS,
          nonce: randomNonce,
          launchWebAuthFlow: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
          signInWithIdToken: (idToken) => signIn(GoogleAuthProvider.credential(idToken)),
        },
        isGoogleChrome: isGoogleChrome(),
      });
    },

    async signOut(): Promise<void> {
      await fbSignOut(auth);
      if (__APP_ENV__ !== 'dev') await dropCachedGoogleToken();
    },

    onChange(cb) {
      onAuthStateChanged(auth, (u) => cb(toAuthUser(u)));
    },

    async joinOrg(): Promise<UserProfile> {
      const call = httpsCallable<void, { profile: UserProfile }>(functions, 'joinOrg');
      try {
        const res = await call();
        return res.data.profile;
      } catch (err) {
        const e = err as { code?: string; message?: string; details?: { reason?: unknown } };
        const reason =
          typeof e.details?.reason === 'string' ? e.details.reason : (e.code ?? 'unknown').replace(/^functions\//, '');
        throw new JoinError(reason, joinErrorMessage(reason));
      }
    },
  };
}
