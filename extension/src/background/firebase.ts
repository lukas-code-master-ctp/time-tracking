/**
 * Firebase inside the MV3 service worker.
 *
 * Service workers have no `window`, `document` nor `XMLHttpRequest`, so:
 * - Auth: `firebase/auth/web-extension` (no DOM/popup/iframe code) with
 *   IndexedDB persistence; the user survives service-worker restarts.
 * - Firestore: `firebase/firestore/lite` (REST over `fetch`). It has no
 *   offline cache: a write while offline fails fast with `unavailable`
 *   instead of staying pending in memory (which would be lost when the worker
 *   sleeps), so the persistent queue in sync.ts owns retries.
 * - Functions: `firebase/functions` (callables over `fetch`).
 * - Storage: the modular `firebase/storage` uploads with XMLHttpRequest,
 *   which does not exist in service workers. {@link uploadToStorage} uploads
 *   with `fetch` to the Storage REST endpoint (same rules apply). Used by the
 *   screenshots (screenshots.ts).
 *
 * Dev build: everything points to the emulators (127.0.0.1, ports from
 * packages/shared). Prod: `.env.production`.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth/web-extension';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore/lite';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import {
  COLLECTIONS,
  EMULATOR_PORTS,
  FIREBASE_DEMO_PROJECT_ID,
  FUNCTIONS_REGION,
  ORG_CONFIG_DOC_ID,
  SCHEDULE_CONFIG_DOC_ID,
  type ActivitySlot,
  type OrgConfig,
  type ScreenshotMeta,
  type Session,
} from '@timetracking/shared';
import { BUILD_CONFIG } from '../env';
import type { Remote } from './remote';

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  /** Base URL of the Storage REST API (emulator in dev). */
  storageBaseUrl: string;
  bucket: string;
}

export function initFirebase(): FirebaseHandles {
  const cfg = BUILD_CONFIG.firebase;
  const dev = __APP_ENV__ === 'dev';
  const projectId = dev ? cfg.projectId || FIREBASE_DEMO_PROJECT_ID : cfg.projectId;
  const app = initializeApp({
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    projectId,
    storageBucket: cfg.storageBucket,
    appId: cfg.appId,
    ...(cfg.messagingSenderId ? { messagingSenderId: cfg.messagingSenderId } : {}),
  });
  const auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
  const db = getFirestore(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);
  let storageBaseUrl = 'https://firebasestorage.googleapis.com';
  if (__APP_ENV__ === 'dev') {
    const host = BUILD_CONFIG.emulatorHost || '127.0.0.1';
    connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, EMULATOR_PORTS.firestore);
    connectFunctionsEmulator(functions, host, EMULATOR_PORTS.functions);
    storageBaseUrl = `http://${host}:${EMULATOR_PORTS.storage}`;
  }
  return { app, auth, db, functions, storageBaseUrl, bucket: cfg.storageBucket };
}

/** Firestore/Storage implementation of {@link Remote} (includes the sync `Backend`). */
export function createFirestoreBackend(h: FirebaseHandles): Remote {
  const { auth, db } = h;
  return {
    async currentUid() {
      await auth.authStateReady();
      return auth.currentUser?.uid ?? null;
    },
    async upsertActivity(docId: string, data: ActivitySlot) {
      // merge + whole `domains` map: domain keys contain dots, so dotted
      // update paths would be wrong.
      await setDoc(doc(db, COLLECTIONS.activity, docId), data, { merge: true });
    },
    async createSession(sessionId: string, data: Session) {
      await setDoc(doc(db, COLLECTIONS.sessions, sessionId), data);
    },
    async heartbeat(sessionId: string, at: number) {
      await updateDoc(doc(db, COLLECTIONS.sessions, sessionId), { lastHeartbeatAt: at });
    },
    async closeSession(sessionId: string, endedAt: number) {
      await updateDoc(doc(db, COLLECTIONS.sessions, sessionId), {
        endedAt,
        endReason: 'manual',
        lastHeartbeatAt: endedAt,
      });
    },
    async fetchOrgConfig() {
      const snap = await getDoc(doc(db, COLLECTIONS.config, ORG_CONFIG_DOC_ID));
      return snap.exists() ? (snap.data() as OrgConfig) : null;
    },
    async fetchSchedule(uid: string) {
      const [config, person] = await Promise.all([
        getDoc(doc(db, COLLECTIONS.config, SCHEDULE_CONFIG_DOC_ID)),
        // Rules not deployed yet (0.2.0 before them): no exception, as if missing.
        getDoc(doc(db, COLLECTIONS.schedules, uid)).catch((err: unknown) => {
          if ((err as { code?: unknown } | null)?.code === 'permission-denied') return null;
          throw err;
        }),
      ]);
      return {
        config: config.exists() ? config.data() : null,
        person: person?.exists() ? person.data() : null,
      };
    },
    async acceptConsent(uid: string, at: number, version: string) {
      // Both fields together, always (the rules require both the first time).
      await updateDoc(doc(db, COLLECTIONS.users, uid), { consentAcceptedAt: at, consentVersion: version });
    },
    uploadScreenshot: (path, jpeg) => uploadToStorage(h, path, jpeg, 'image/jpeg'),
    screenshotExists: (path) => storageObjectExists(h, path),
    async putScreenshotMeta(id: string, meta: ScreenshotMeta) {
      await setDoc(doc(db, COLLECTIONS.screenshots, id), meta);
    },
  };
}

async function storageToken(h: FirebaseHandles): Promise<string> {
  // After a worker restart the persisted user is restored asynchronously.
  await h.auth.authStateReady();
  const user = h.auth.currentUser;
  if (!user) throw Object.assign(new Error('Sin sesión'), { code: 'unauthenticated' });
  // Refreshed by the SDK when it is about to expire (1 h lifetime).
  return user.getIdToken();
}

function objectUrl(h: FirebaseHandles, path: string): string {
  return `${h.storageBaseUrl}/v0/b/${encodeURIComponent(h.bucket)}/o/${encodeURIComponent(path)}`;
}

/**
 * True when the object exists (metadata GET, allowed to its owner). Used when
 * a re-upload is refused: Storage rules never overwrite.
 */
export async function storageObjectExists(h: FirebaseHandles, path: string): Promise<boolean> {
  const token = await storageToken(h);
  const res = await fetch(objectUrl(h, path), { headers: { Authorization: `Firebase ${token}` } });
  if (res.ok) return true;
  // 404 = not there; 403 = not readable (another uid): either way not "ours".
  if (res.status === 404 || res.status === 403) return false;
  throw Object.assign(new Error(`Storage ${res.status}`), { code: storageErrorCode(res.status) });
}

/**
 * Uploads a file to Cloud Storage with `fetch` (the modular SDK needs
 * XMLHttpRequest). Security rules apply as usual: the Firebase ID token goes
 * in the `Authorization: Firebase <token>` header.
 */
export async function uploadToStorage(
  h: FirebaseHandles,
  path: string,
  body: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<void> {
  const token = await storageToken(h);
  const url = `${h.storageBaseUrl}/v0/b/${encodeURIComponent(h.bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Firebase ${token}`, 'Content-Type': contentType },
    body,
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Storage ${res.status}`), { code: storageErrorCode(res.status) });
  }
}

/** Maps a Storage REST status to the error codes that sync.ts `classify()` understands. */
export function storageErrorCode(status: number): string {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'permission-denied';
  if (status === 409 || status === 412) return 'already-exists';
  // Rate limited / request timeout: transient, retry with backoff.
  if (status === 429) return 'resource-exhausted';
  if (status === 408) return 'deadline-exceeded';
  if (status >= 500) return 'unavailable';
  return 'invalid-argument';
}
