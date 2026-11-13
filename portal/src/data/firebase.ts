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
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type ActionCodeSettings,
  type User,
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
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
  SCHEDULE_CONFIG_DOC_ID,
  absenceOverlapsRange,
  emailKey,
  readAllowedDomains,
  readAttendanceSettings,
  readCelebration,
  readDailyReport,
  readGroup,
  readKiosk,
  readPersonSchedule,
  readScheduleConfig,
  type Absence,
  type AttendancePhoto,
  type ActiveBreak,
  type ActivitySlot,
  type Announcement,
  type AnnouncementRead,
  type Celebration,
  type DailyReport,
  type Invitation,
  type MoodWeek,
  isFeedback,
  BREAK_VIDEOS_DOC_ID,
  type OrgConfig,
  type PersonSchedule,
  type ScreenshotMeta,
  type Session,
  type UserProfile,
  type WithId,
} from '@timetracking/shared';
import { ALLOWED_DOMAINS, FIREBASE_CONFIG, googleLoginParams } from '../env';
import { SESSION_LOOKBACK_MS } from '../lib/team';
import { joinErrorMessage } from '../lib/messages';
import { JoinError, type AuthApi, type PasswordOutcome, type Backend, type DataSource, type TimeRange } from './types';

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
  // Verification and reset emails from Firebase Auth in Spanish.
  auth.languageCode = 'es';
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

  /**
   * Every valid document of a small collection; `[]` while its rules are not
   * deployed (permission-denied), so the page still works.
   */
  async function readValid<T>(name: string, read: (raw: unknown) => T | null, what: string): Promise<WithId<T>[]> {
    try {
      const snap = await getDocs(collection(db, name));
      const out: WithId<T>[] = [];
      for (const d of snap.docs) {
        const v = read(d.data());
        if (v) out.push({ ...v, id: d.id });
      }
      return out;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'permission-denied') {
        console.warn(`[timetracking] no se pudieron leer ${what}`, err);
        return [];
      }
      throw err;
    }
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
      if (!snap.exists()) return null;
      // Old documents may carry a single `allowedDomain`: expose the list.
      const { allowedDomain: _legacy, ...raw } = snap.data() as OrgConfig & { allowedDomain?: unknown };
      return { ...raw, allowedDomains: readAllowedDomains(snap.data()) };
    },
    async saveOrgConfig(config) {
      await setDoc(doc(db, COLLECTIONS.config, ORG_CONFIG_DOC_ID), config);
    },
    async getBreakVideos() {
      const snap = await getDoc(doc(db, COLLECTIONS.config, BREAK_VIDEOS_DOC_ID));
      return snap.exists() ? snap.data() : null;
    },
    async saveBreakVideos(config) {
      await setDoc(doc(db, COLLECTIONS.config, BREAK_VIDEOS_DOC_ID), config);
    },
    async getScheduleConfig() {
      const snap = await getDoc(doc(db, COLLECTIONS.config, SCHEDULE_CONFIG_DOC_ID));
      return snap.exists() ? readScheduleConfig(snap.data()) : null;
    },
    async saveScheduleConfig(config) {
      await setDoc(doc(db, COLLECTIONS.config, SCHEDULE_CONFIG_DOC_ID), config);
    },
    async deleteScheduleConfig() {
      await deleteDoc(doc(db, COLLECTIONS.config, SCHEDULE_CONFIG_DOC_ID));
    },
    async listPersonSchedules() {
      const snap = await getDocs(collection(db, COLLECTIONS.schedules));
      const out: WithId<PersonSchedule>[] = [];
      for (const d of snap.docs) {
        const s = readPersonSchedule(d.data());
        if (s) out.push({ ...s, id: d.id });
      }
      return out;
    },
    async getPersonSchedule(uid) {
      const snap = await getDoc(doc(db, COLLECTIONS.schedules, uid));
      return snap.exists() ? readPersonSchedule(snap.data()) : null;
    },
    async savePersonSchedule(uid, schedule) {
      await setDoc(doc(db, COLLECTIONS.schedules, uid), schedule);
    },
    async deletePersonSchedule(uid) {
      await deleteDoc(doc(db, COLLECTIONS.schedules, uid));
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
    async listBreaks(uid, range) {
      try {
        const docs = await readAll<ActiveBreak>(COLLECTIONS.breaks, 'start', [
          where('uid', '==', uid),
          where('start', '>=', range.from),
          where('start', '<', range.to),
        ]);
        return docs.map(({ id: _id, ...b }) => b);
      } catch (err) {
        // Rules or index of the active breaks not deployed yet: the page works without them.
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'permission-denied' || code === 'failed-precondition') {
          console.warn('[timetracking] no se pudieron leer las pausas activas', err);
          return [];
        }
        throw err;
      }
    },
    async listAbsences(fromDate, toDate, uid) {
      try {
        // One person: all of theirs (a handful). Everybody: those ending in
        // the range or later (single-field index). The rest is filtered here.
        const q = uid
          ? query(collection(db, COLLECTIONS.absences), where('uid', '==', uid))
          : query(collection(db, COLLECTIONS.absences), where('endDate', '>=', fromDate));
        const snap = await getDocs(q);
        return snap.docs
          .map((d) => ({ ...(d.data() as Absence), id: d.id }))
          .filter((a) => absenceOverlapsRange(a, fromDate, toDate));
      } catch (err) {
        // Rules of the absences not deployed yet: the pages work without them.
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') {
          console.warn('[timetracking] no se pudieron leer las ausencias justificadas', err);
          return [];
        }
        throw err;
      }
    },
    async listPendingAbsences() {
      try {
        const snap = await getDocs(query(collection(db, COLLECTIONS.absences), where('status', '==', 'pending')));
        return snap.docs.map((d) => ({ ...(d.data() as Absence), id: d.id }));
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') return [];
        throw err;
      }
    },
    async saveAbsence(id, absence) {
      const target = id ? doc(db, COLLECTIONS.absences, id) : doc(collection(db, COLLECTIONS.absences));
      await setDoc(target, absence);
      return target.id;
    },
    async deleteAbsence(id) {
      await deleteDoc(doc(db, COLLECTIONS.absences, id));
    },
    async listAnnouncements() {
      try {
        const snap = await getDocs(query(collection(db, COLLECTIONS.announcements), orderBy('createdAt', 'desc')));
        return snap.docs.map((d) => ({ ...(d.data() as Announcement), id: d.id }));
      } catch (err) {
        // Rules of the announcements not deployed yet: the page shows none.
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') {
          console.warn('[timetracking] no se pudieron leer los comunicados', err);
          return [];
        }
        throw err;
      }
    },
    async listAttendanceSettings() {
      return readValid(COLLECTIONS.attendanceSettings, readAttendanceSettings, 'las marcaciones');
    },
    async saveAttendanceSettings(uid, settings) {
      await setDoc(doc(db, COLLECTIONS.attendanceSettings, uid), settings);
    },
    async listAttendancePhotos(fromDate, toDate) {
      try {
        const snap = await getDocs(
          query(collection(db, COLLECTIONS.attendancePhotos), where('date', '>=', fromDate), where('date', '<=', toDate)),
        );
        return snap.docs.map((d) => ({ ...(d.data() as AttendancePhoto), id: d.id }));
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') {
          console.warn('[timetracking] no se pudieron leer las fotos del tótem', err);
          return [];
        }
        throw err;
      }
    },
    async listGroups() {
      return readValid(COLLECTIONS.groups, readGroup, 'los grupos');
    },
    async saveGroup(id, group) {
      const target = id ? doc(db, COLLECTIONS.groups, id) : doc(collection(db, COLLECTIONS.groups));
      await setDoc(target, group);
      return target.id;
    },
    async deleteGroup(id) {
      await deleteDoc(doc(db, COLLECTIONS.groups, id));
    },
    async listKiosks() {
      return readValid(COLLECTIONS.kiosks, readKiosk, 'los tótems');
    },
    async createKiosk(id, kiosk) {
      await setDoc(doc(db, COLLECTIONS.kiosks, id), kiosk);
    },
    async revokeKiosk(id, revokedAt) {
      await updateDoc(doc(db, COLLECTIONS.kiosks, id), { revokedAt });
    },
    async deleteKiosk(id) {
      await deleteDoc(doc(db, COLLECTIONS.kiosks, id));
    },
    async listCelebrations() {
      try {
        const snap = await getDocs(collection(db, COLLECTIONS.celebrations));
        const out: WithId<Celebration>[] = [];
        for (const d of snap.docs) {
          const c = readCelebration(d.data());
          if (c) out.push({ ...c, id: d.id });
        }
        return out;
      } catch (err) {
        // Rules of the celebrations not deployed yet: the page works without them.
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') {
          console.warn('[timetracking] no se pudieron leer los cumpleaños y aniversarios', err);
          return [];
        }
        throw err;
      }
    },
    async listAnnouncementReads() {
      try {
        const snap = await getDocs(collection(db, COLLECTIONS.announcementReads));
        return snap.docs.map((d) => d.data() as AnnouncementRead);
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') return [];
        throw err;
      }
    },
    async listDailyReports(fromDate, toDate) {
      try {
        const snap = await getDocs(
          query(collection(db, COLLECTIONS.dailyReports), where('date', '>=', fromDate), where('date', '<=', toDate)),
        );
        const out: WithId<DailyReport>[] = [];
        for (const d of snap.docs) {
          const r = readDailyReport(d.data());
          if (r) out.push({ ...r, id: d.id });
        }
        return out;
      } catch (err) {
        // Rules of the daily report not deployed yet: no reports.
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') return [];
        throw err;
      }
    },
    async listMoodWeeks() {
      try {
        const snap = await getDocs(collection(db, COLLECTIONS.moodWeeks));
        return snap.docs.map((d) => ({ ...(d.data() as MoodWeek), id: d.id }));
      } catch (err) {
        // Rules of the mood pulse not deployed yet: the page shows no answers.
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') return [];
        throw err;
      }
    },
    async listFeedback(fromWeek) {
      try {
        const snap = await getDocs(query(collection(db, COLLECTIONS.feedback), where('week', '>=', fromWeek)));
        return snap.docs.flatMap((d) => {
          const v = d.data();
          return isFeedback(v) ? [{ week: v.week, tone: v.tone, text: v.text, id: d.id }] : [];
        });
      } catch (err) {
        // Rules of the anonymous comments not deployed yet: the page shows none.
        if ((err as { code?: unknown } | null)?.code === 'permission-denied') return [];
        throw err;
      }
    },
    async deleteFeedback(id) {
      await deleteDoc(doc(db, COLLECTIONS.feedback, id));
    },
    async createAnnouncement(announcement) {
      const target = doc(collection(db, COLLECTIONS.announcements));
      await setDoc(target, announcement);
      return target.id;
    },
    async updateAnnouncement(id, patch) {
      await updateDoc(doc(db, COLLECTIONS.announcements, id), patch);
    },
    async setAnnouncementArchived(id, archivedAt) {
      await updateDoc(doc(db, COLLECTIONS.announcements, id), { archivedAt });
    },
    async deleteAnnouncement(id) {
      await deleteDoc(doc(db, COLLECTIONS.announcements, id));
    },
    async saveCelebration(uid, celebration) {
      await setDoc(doc(db, COLLECTIONS.celebrations, uid), celebration);
    },
    screenshotUrl(storagePath) {
      return getDownloadURL(ref(storage, storagePath));
    },
  };

  /**
   * Runs an email action with a "Continuar" link back to the portal. A domain
   * not authorized in Firebase Auth (e.g. a preview URL) gets the plain email.
   */
  async function withContinueUrl(send: (settings?: ActionCodeSettings) => Promise<void>): Promise<void> {
    try {
      await send({ url: `${window.location.origin}/` });
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'auth/unauthorized-continue-uri' || code === 'auth/invalid-continue-uri') await send();
      else throw err;
    }
  }

  const sendVerification = (user: User): Promise<void> =>
    withContinueUrl((settings) => sendEmailVerification(user, settings ?? null));

  const authApi: AuthApi = {
    onChange(cb) {
      return onAuthStateChanged(auth, (u) =>
        cb(u ? { uid: u.uid, email: u.email, displayName: u.displayName, emailVerified: u.emailVerified } : null),
      );
    },
    async signInWithPassword(email, password): Promise<PasswordOutcome> {
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      if (user.emailVerified) return 'signed-in';
      await sendVerification(user);
      await signOut(auth);
      return 'verification-sent';
    },
    async createPasswordAccount(email, password) {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      try {
        await sendVerification(user);
      } finally {
        await signOut(auth);
      }
    },
    async sendPasswordReset(email) {
      try {
        await withContinueUrl((settings) => sendPasswordResetEmail(auth, email, settings));
      } catch (err) {
        // Same answer for unknown emails (prod has email enumeration protection; the emulator does not).
        if ((err as { code?: unknown } | null)?.code !== 'auth/user-not-found') throw err;
      }
    },
    async signIn() {
      const provider = new GoogleAuthProvider();
      // `hd` only with a single domain (see googleLoginParams); joinOrg enforces the domains.
      provider.setCustomParameters(googleLoginParams(ALLOWED_DOMAINS));
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
        throw new JoinError(reason, joinErrorMessage(reason, ALLOWED_DOMAINS));
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
