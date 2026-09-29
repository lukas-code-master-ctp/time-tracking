/**
 * Shared setup for tests that run inside `firebase emulators:exec`
 * (auth, firestore, storage, functions). The Admin SDK talks to the
 * emulators through the *_EMULATOR_HOST variables set by the CLI.
 */
import { deleteApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { FIREBASE_DEMO_PROJECT_ID, FUNCTIONS_REGION, EMULATOR_PORTS } from '@timetracking/shared';

export const PROJECT_ID = FIREBASE_DEMO_PROJECT_ID;
export const BUCKET = `${PROJECT_ID}.appspot.com`;
export const NOW = 1_790_000_000_000;
export const DAY = 24 * 60 * 60 * 1000;

function hostOf(envVar: string, port: number): string {
  const raw = process.env[envVar];
  return raw && raw.trim() !== '' ? raw.trim() : `127.0.0.1:${port}`;
}

// Defaults for running vitest against already-started emulators.
process.env.FIRESTORE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.auth}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= `127.0.0.1:${EMULATOR_PORTS.storage}`;

export const hosts = {
  firestore: hostOf('FIRESTORE_EMULATOR_HOST', EMULATOR_PORTS.firestore),
  auth: hostOf('FIREBASE_AUTH_EMULATOR_HOST', EMULATOR_PORTS.auth),
  functions: `127.0.0.1:${EMULATOR_PORTS.functions}`,
};

export function adminApp(): App {
  return (
    getApps()[0] ?? initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET })
  );
}

export const db = (): Firestore => getFirestore(adminApp());
export const auth = () => getAuth(adminApp());
export const bucket = () => getStorage(adminApp()).bucket(BUCKET);

export async function closeAdmin(): Promise<void> {
  await Promise.all(getApps().map((a) => deleteApp(a)));
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
}

export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${hosts.firestore}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  await expectOk(res, 'clearFirestore');
}

export async function clearAuth(): Promise<void> {
  const res = await fetch(`http://${hosts.auth}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: 'DELETE',
  });
  await expectOk(res, 'clearAuth');
}

export async function clearStorage(): Promise<void> {
  await bucket().deleteFiles({ force: true });
}

export async function seed(docs: Record<string, object>): Promise<void> {
  const firestore = db();
  await Promise.all(Object.entries(docs).map(([path, data]) => firestore.doc(path).set(data)));
}

export async function getDoc<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
  const snap = await db().doc(path).get();
  return snap.exists ? (snap.data() as T) : undefined;
}

// ---------- real callable through the Functions emulator ----------

/** Test-only password for users created in the Auth emulator. */
const TEST_PASSWORD = 'emulator-only-password';

/** Creates a user in the Auth emulator and returns an ID token for it. */
export async function idTokenFor(user: {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
}): Promise<string> {
  await auth().createUser({ ...user, password: TEST_PASSWORD });
  const res = await fetch(
    `http://${hosts.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );
  await expectOk(res, 'signInWithPassword');
  const body = (await res.json()) as { idToken: string };
  return body.idToken;
}

export interface CallableResponse<T> {
  status: number;
  result?: T;
  error?: { status: string; message: string; details?: unknown };
}

export async function callFunction<T>(
  name: string,
  data: unknown,
  idToken?: string,
): Promise<CallableResponse<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetch(`http://${hosts.functions}/${PROJECT_ID}/${FUNCTIONS_REGION}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
  });
  const body = (await res.json()) as Omit<CallableResponse<T>, 'status'>;
  return { status: res.status, ...body };
}

/** True when the Functions emulator answers on its port. */
export async function functionsEmulatorUp(): Promise<boolean> {
  try {
    await fetch(`http://${hosts.functions}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}
