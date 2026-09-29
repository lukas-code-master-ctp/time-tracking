import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { UserProfile } from '@timetracking/shared';
import { errorMessage } from '../lib/messages';
import { JoinError, type AuthUser, type Backend, type DataSource } from './types';

const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('BackendProvider missing');
  return b;
}

export function useData(): DataSource {
  return useBackend().data;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut'; error?: string }
  | { status: 'joining'; user: AuthUser }
  | { status: 'noAccess'; user: AuthUser; message: string }
  | { status: 'ready'; user: AuthUser; profile: UserProfile };

interface SessionApi {
  state: SessionState;
  signIn(): Promise<void>;
  signInDev?: (email: string) => Promise<void>;
  signOut(): Promise<void>;
  retry(): void;
}

const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const s = useContext(SessionContext);
  if (!s) throw new Error('BackendProvider missing');
  return s;
}

/** Signed-in admin (only valid inside the authenticated layout). */
export function useAdmin(): { uid: string; profile: UserProfile } {
  const { state } = useSession();
  if (state.status !== 'ready') throw new Error('useAdmin outside the admin area');
  return { uid: state.user.uid, profile: state.profile };
}

/**
 * Sign-in flow: Firebase Auth user → `joinOrg` → admin check. Only an active
 * admin reaches the portal; anyone else sees "Sin acceso".
 */
export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = 0;
    const join = async (user: AuthUser, ticket: number): Promise<void> => {
      setState({ status: 'joining', user });
      try {
        const profile = await backend.auth.joinOrg();
        if (ticket !== current) return;
        if (profile.role !== 'admin' || profile.status !== 'active') {
          setState({
            status: 'noAccess',
            user,
            message:
              profile.status !== 'active'
                ? 'Tu cuenta está desactivada. Habla con un administrador.'
                : 'Tu cuenta es de colaborador. El portal es solo para administradores: registra tu jornada desde la extensión de Chrome.',
          });
          return;
        }
        setState({ status: 'ready', user, profile });
      } catch (err) {
        if (ticket !== current) return;
        setState({ status: 'noAccess', user, message: err instanceof JoinError ? err.message : errorMessage(err) });
      }
    };
    const unsubscribe = backend.auth.onChange((user) => {
      current++;
      if (!user) setState((s) => (s.status === 'signedOut' ? s : { status: 'signedOut' }));
      else void join(user, current);
    });
    return () => {
      current++;
      unsubscribe();
    };
  }, [backend, attempt]);

  const signIn = useCallback(async () => {
    try {
      await backend.auth.signIn();
    } catch (err) {
      setState({ status: 'signedOut', error: errorMessage(err) });
    }
  }, [backend]);

  const signInDevFn = backend.auth.signInDev;
  const signInDev = useCallback(
    async (email: string) => {
      try {
        await signInDevFn?.(email);
      } catch (err) {
        setState({ status: 'signedOut', error: errorMessage(err) });
      }
    },
    [signInDevFn],
  );

  const signOut = useCallback(async () => {
    await backend.auth.signOut();
  }, [backend]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const api: SessionApi = { state, signIn, signOut, retry, ...(signInDevFn ? { signInDev } : {}) };
  return (
    <BackendContext.Provider value={backend}>
      <SessionContext.Provider value={api}>{children}</SessionContext.Provider>
    </BackendContext.Provider>
  );
}
