/**
 * Authentication of the extension (lives in the service worker; the popup
 * only sends messages).
 *
 * - Dev build: `signInDev(email)` signs in to the Auth emulator with a fake
 *   Google credential (`GoogleAuthProvider.credential(JSON.stringify({ sub,
 *   email, email_verified: true }))`, accepted only by the emulator).
 * - Prod build: `signInInteractive()` with `chrome.identity.getAuthToken`
 *   — Task 5.
 * - After signing in, `joinOrg()` calls the callable of the same name, which
 *   creates `users/{uid}` or rejects with `details.reason` (no invitation,
 *   domain not allowed…).
 */
import {
  GoogleAuthProvider,
  signInWithCredential,
  signOut as fbSignOut,
  type Auth,
  type User,
} from 'firebase/auth/web-extension';
import { httpsCallable, type Functions } from 'firebase/functions';
import { emailKey, type UserProfile } from '@timetracking/shared';

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
  /** Google sign-in with chrome.identity (Task 5). */
  signInInteractive(): Promise<AuthUser>;
  signOut(): Promise<void>;
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

    async signInInteractive(): Promise<AuthUser> {
      // Task 5: chrome.identity.getAuthToken({ interactive: true }) →
      // GoogleAuthProvider.credential(null, token) → signInWithCredential.
      throw new AuthError('not-implemented', 'El inicio de sesión con Google llegará en la próxima versión.');
    },

    async signOut(): Promise<void> {
      await fbSignOut(auth);
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
        throw new JoinError(reason, e.message ?? 'No se pudo validar tu cuenta.');
      }
    },
  };
}
