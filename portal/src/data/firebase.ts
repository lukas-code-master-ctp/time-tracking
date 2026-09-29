/**
 * Firebase implementation of {@link Backend} (web SDK, modular).
 *
 * - All times are epoch-ms numbers (see packages/shared/src/types.ts), so range
 *   queries are plain `where('slotStart', '>=', from)`.
 * - Large ranges are read in pages (`orderBy` + `startAfter`).
 * - Dev (`vite --mode development`): emulators + fake Google credential. The
 *   dev branches sit behind `import.meta.env.DEV`, which Vite replaces with `false` in the
 *   production build, so that code is dropped (checked by scripts/check-build.ts).
 */
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  updateDoc,
  where,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getDownloadURL, getStorage, ref } from 'firebase/storage';
import {
  COLLECTIONS,
  EMULATOR_PORTS,
  FUNCTIONS_REGION,
  ORG_CONFIG_DOC_ID,
  emailKey,
  type ActivitySlot,
  type Invitation,
  type OrgConfig,
  type ScreenshotMeta,
  type Session,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { ALLOWED_DOMAIN, FIREBASE_CONFIG } from '../env';
import { SESSION_LOOKBACK_MS } from '../lib/team';
import { joinErrorMessage } from '../lib/messages';
import { JoinError, type AuthApi, type Backend, type DataSource, type TimeRange } from './types';

const PAGE_SIZE = 1000;

/** Fake Google ID token accepted by the Auth emulator (same shape as the extension's). */
export function devGoogleIdToken(email: string): string {
  const e = emailKey(email);
  return JSON.stringify({
    sub: `dev-${e.replace(/[^a-z0-9]/g, '-')}`,
    email: e,
    email_verified: true,
    name: e.slice(0, e.indexOf('@')),
  });
}

export function createFirebaseBackend(): Backend {
  const app = initializeApp({
    apiKey: FIREBASE_CONFIG.apiKey,
    authDomain: FIREBASE_CONFIG.authDomain,
    projectId: FIREBASE_CONFIG.projectId,
    storageBucket: FIREBASE_CONFIG.storageBucket,
    appId: FIREBASE_CONFIG.appId,
    ...(FIREBASE_CONFIG.messagingSenderId ? { messagingSenderId: FIREBASE_CONFIG.messagingSenderId } : {}),
  });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);
  const storage = getStorage(app);
  if (import.meta.env.DEV) {
    const host = import.meta.env.VITE_EMULATOR_HOST || '127.0.0.1';
    connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, EMULATOR_PORTS.firestore);
    connectFunctionsEmulator(functions, host, EMULATOR_PORTS.functions);
    connectStorageEmulator(storage, host, EMULATOR_PORTS.storage);
  }

  /** Reads every document of a query ordered by `field`, in pages. */
  async function readAll<T>(name: string, field: string, constraints: QueryConstraint[]): Promise<WithId<T>[]> {
    const out: WithId<T>[] = [];
    let last: QueryDocumentSnapshot | undefined;
    for (;;) {
      const page = [...constraints, orderBy(field), ...(last ? [startAfter(last)] : []), limit(PAGE_SIZE)];
      const snap = await getDocs(query(collection(db, name), ...page));
      for (const d of snap.docs) out.push({ ...(d.data() as T), id: d.id });
      if (snap.docs.length < PAGE_SIZE) return out;
      last = snap.docs[snap.docs.length - 1];
    }
  }

  const byUid = (uid?: string): QueryConstraint[] => (uid ? [where('uid', '==', uid)] : []);

  const data: DataSource = {
    async getOrgConfig() {
      const snap = await getDoc(doc(db, COLLECTIONS.config, ORG_CONFIG_DOC_ID));
      return snap.exists() ? (snap.data() as OrgConfig) : null;
    },
    async saveOrgConfig(config) {
      await setDoc(doc(db, COLLECTIONS.config, ORG_CONFIG_DOC_ID), config);
    },
    async listUsers() {
      const snap = await getDocs(collection(db, COLLECTIONS.users));
      return snap.docs.map((d) => ({ ...(d.data() as UserProfile), id: d.id }));
    },
    async getUser(uid) {
      const snap = await getDoc(doc(db, COLLECTIONS.users, uid));
      return snap.exists() ? { ...(snap.data() as UserProfile), id: snap.id } : null;
    },
    async updateUser(uid, patch) {
      await updateDoc(doc(db, COLLECTIONS.users, uid), { role: patch.role, status: patch.status });
    },
    async listInvitations() {
      const snap = await getDocs(collection(db, COLLECTIONS.invitations));
      return snap.docs.map((d) => ({ ...(d.data() as Invitation), id: d.id }));
    },
    async putInvitation(id, invitation) {
      await setDoc(doc(db, COLLECTIONS.invitations, id), invitation);
    },
    async listActivity(range: TimeRange, uid?: string) {
      const docs = await readAll<ActivitySlot>(COLLECTIONS.activity, 'slotStart', [
        ...byUid(uid),
        where('slotStart', '>=', range.from),
        where('slotStart', '<', range.to),
      ]);
      return docs.map(({ id: _id, ...slot }) => slot);
    },
    async listSessions(range: TimeRange, uid?: string) {
      const [started, open] = await Promise.all([
        readAll<Session>(COLLECTIONS.sessions, 'startedAt', [
          ...byUid(uid),
          where('startedAt', '>=', range.from - SESSION_LOOKBACK_MS),
          where('startedAt', '<', range.to),
        ]),
        // Still-open sessions, whatever their start (normally a handful).
        getDocs(query(collection(db, COLLECTIONS.sessions), ...byUid(uid), where('endedAt', '==', null))).then((snap) =>
          snap.docs.map((d) => ({ ...(d.data() as Session), id: d.id })),
        ),
      ]);
      const byId = new Map<string, WithId<Session>>();
      for (const s of [...started, ...open]) byId.set(s.id, s);
      return [...byId.values()];
    },
    async listScreenshots(uid, range) {
      return readAll<ScreenshotMeta>(COLLECTIONS.screenshots, 'takenAt', [
        where('uid', '==', uid),
        where('takenAt', '>=', range.from),
        where('takenAt', '<', range.to),
      ]);
    },
    screenshotUrl(storagePath) {
      return getDownloadURL(ref(storage, storagePath));
    },
  };

  const authApi: AuthApi = {
    onChange(cb) {
      return onAuthStateChanged(auth, (u) =>
        cb(u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null),
      );
    },
    async signIn() {
      const provider = new GoogleAuthProvider();
      // `hd` pre-selects / restricts the Google account chooser to the Workspace
      // domain. It is only a hint: joinOrg enforces the domain on the server.
      provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    },
    async signOut() {
      await signOut(auth);
    },
    async joinOrg() {
      const call = httpsCallable<void, { profile: UserProfile }>(functions, 'joinOrg');
      try {
        const res = await call();
        return res.data.profile;
      } catch (err) {
        const e = err as { code?: string; details?: { reason?: unknown } };
        const reason =
          typeof e.details?.reason === 'string' ? e.details.reason : (e.code ?? 'unknown').replace(/^functions\//, '');
        throw new JoinError(reason, joinErrorMessage(reason, ALLOWED_DOMAIN));
      }
    },
  };
  if (import.meta.env.DEV) {
    authApi.signInDev = async (email: string) => {
      await signInWithCredential(auth, GoogleAuthProvider.credential(devGoogleIdToken(email)));
    };
  }
  return { auth: authApi, data };
}
