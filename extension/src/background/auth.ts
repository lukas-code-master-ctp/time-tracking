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
 * - After signing in, `joinOrg()` calls the callable of the same name, which
 *   creates `users/{uid}` or rejects with `details.reason` (no invitation,
 *   domain not allowed…), mapped to clear Spanish messages here.
 * - Signing out also drops Chrome's cached token.
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
import { emailKey, type UserProfile } from '@timetracking/shared';
import { ALLOWED_DOMAIN } from '../env';

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
  /** Google sign-in with chrome.identity. Throws {@link AuthError}. */
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
export function joinErrorMessage(reason: string, domain: string = ALLOWED_DOMAIN): string {
  switch (reason) {
    case 'no-invitation':
      return 'Aún no tienes una invitación. Pide a tu administrador que te invite y luego pulsa “Reintentar”.';
    case 'invitation-revoked':
      return 'Tu invitación fue revocada. Pide a tu administrador que te invite de nuevo.';
    case 'domain-not-allowed':
      return `Esta cuenta no es de la empresa. Usa tu cuenta @${domain} (la cuenta con la que iniciaste sesión en Chrome).`;
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

/** chrome.identity rejection → AuthError (cancelled vs failure). */
export function identityError(err: unknown): AuthError {
  const msg = messageOf(err);
  if (/did not approve|canceled|cancelled|user interaction required|not signed in|closed/i.test(msg)) {
    return new AuthError('cancelled', 'Se canceló el inicio de sesión. Pulsa “Iniciar sesión con Google” para intentarlo de nuevo.');
  }
  if (/oauth2|client id|bad client/i.test(msg)) {
    return new AuthError('oauth-config', 'La extensión no tiene configurado el inicio de sesión con Google. Avisa a tu administrador.');
  }
  return new AuthError('identity-failed', `No se pudo iniciar sesión con Google (${msg || 'error desconocido'}).`);
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
    if (!token) throw new AuthError('cancelled', 'Se canceló el inicio de sesión.');
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

async function chromeAuthToken(interactive: boolean): Promise<string> {
  const res = (await chrome.identity.getAuthToken({ interactive })) as chrome.identity.GetAuthTokenResult | string | undefined;
  return typeof res === 'string' ? res : (res?.token ?? '');
}

/** Removes Chrome's cached Google token (sign-out). Never throws. */
export async function dropCachedGoogleToken(): Promise<void> {
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
      return googleSignIn({
        getAuthToken: chromeAuthToken,
        removeCachedAuthToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
        async signInWithToken(accessToken) {
          const result = await signInWithCredential(auth, GoogleAuthProvider.credential(null, accessToken));
          return toAuthUser(result.user) as AuthUser;
        },
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
