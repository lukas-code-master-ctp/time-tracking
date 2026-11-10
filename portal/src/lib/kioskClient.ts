/**
 * Client of the `kioskPunch` callable for the kiosk page (/marcar). The kiosk
 * has no sign-in: a separate Firebase app with only Functions, so the page
 * never touches Auth or Firestore.
 */
import { initializeApp } from 'firebase/app';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { EMULATOR_PORTS, FUNCTIONS_REGION } from '@timetracking/shared';
import { FIREBASE_CONFIG } from '../env';

export type PunchAction = 'in' | 'out';

export interface PunchResult {
  action: PunchAction;
  firstName: string;
  at: number;
  startedAt: number;
}

export class PunchError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PunchError';
  }
}

export type Punch = (input: { token: string; rut: string; action: PunchAction }) => Promise<PunchResult>;

export function createKioskPunch(): Punch {
  const app = initializeApp(
    {
      apiKey: FIREBASE_CONFIG.apiKey,
      projectId: FIREBASE_CONFIG.projectId,
      appId: FIREBASE_CONFIG.appId,
    },
    'kiosk',
  );
  const functions = getFunctions(app, FUNCTIONS_REGION);
  if (import.meta.env.DEV) {
    connectFunctionsEmulator(functions, import.meta.env.VITE_EMULATOR_HOST || '127.0.0.1', EMULATOR_PORTS.functions);
  }
  const call = httpsCallable<{ token: string; rut: string; action: PunchAction }, PunchResult>(functions, 'kioskPunch');
  return async (input) => {
    try {
      return (await call(input)).data;
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: { reason?: unknown } };
      const reason = typeof e.details?.reason === 'string' ? e.details.reason : (e.code ?? 'unknown').replace(/^functions\//, '');
      const known = typeof e.details?.reason === 'string' && e.message;
      throw new PunchError(
        reason,
        known ? e.message!.replace(/\s*\[\d{3}\]$/, '') : reason === 'unavailable' || reason === 'internal' ? 'No hay conexión. Intenta de nuevo en un momento.' : 'No se pudo marcar. Intenta de nuevo.',
      );
    }
  };
}
