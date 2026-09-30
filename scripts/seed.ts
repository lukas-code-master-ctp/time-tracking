/**
 * Demo data in the local Firebase emulators: `npm run seed` (root), with the
 * emulators already running (`npm run emulators` or `npm run emulators:persist`).
 *
 * - Bootstrap admin `lukas@impulseai.cl` (Auth + users, role admin).
 * - 3 collaborators (Ana and Beto @compratuparcela.cl, Carla @impulseai.cl)
 *   with accepted invitations and accepted notice, and 1 pending invitation
 *   (Diego @impulseai.cl).
 * - `config/org` with blurred screenshots on, and `config/schedule`
 *   (Monday–Thursday 09:00–18:30 with lunch 13:00–14:00, Friday 09:00–14:00,
 *   weekend off, Chilean holidays 2026–2027, tolerance 5, reminders on). Both
 *   only when missing: on re-runs the admin's changes are kept.
 * - Carla's exception `schedules/{uid}`: half day 09:00–13:00, Monday to
 *   Friday (demo collaborator data: rewritten on every run).
 * - Sessions and activity for the last 7 days following each person's
 *   schedule (variable %, typical sites, time outside Chrome; a late arrival,
 *   an early leave, an absence and time outside the schedule; like extension
 *   0.2.0, nothing is measured in the lunch nor outside the schedule), one
 *   session open right now (Ana) and a few blurred sample screenshots in
 *   Storage + docs.
 * - Web meetings ("En reunión"): a 30-min daily every weekday at 09:30, one
 *   1-hour meeting per person and week, and the video calls in between carry
 *   `meetingSeconds`; the oldest day is written like extension 0.1.1 (no
 *   `meetingSeconds`).
 *
 * Auth accounts are created with the same fake Google token as the dev login,
 * so you can sign in as any of them in the dev portal / dev extension.
 *
 * Idempotent: running it again replaces the demo collaborators' sessions,
 * activity and screenshots (nothing else is deleted).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { chromium } from 'playwright';
import {
  COLLECTIONS,
  CONSENT_VERSION,
  SCHEDULE_CONFIG_DOC_ID,
  activityDocId,
  screenshotStoragePath,
  type Invitation,
  type OrgConfig,
  type PersonSchedule,
  type ScheduleConfig,
  type ScreenshotMeta,
  type UserProfile,
} from '@timetracking/shared';
import { findChromium, NO_CHROMIUM } from './lib/chromium.ts';
import {
  ADMIN_EMAIL,
  BUCKET,
  DOMAINS,
  PROJECT,
  assertEmulators,
  deleteStorageObject,
  devGoogleSignIn,
  storageObjects,
  uploadJpeg,
  useEmulatorEnv,
} from './lib/emulators.ts';
import { SHOT_HEIGHT, SHOT_WIDTH, renderMockScreens } from './lib/mockScreens.ts';
import { PENDING_INVITE, PEOPLE, SEED_EXCEPTIONS, SEED_SCHEDULE, buildDataset } from './lib/seedData.ts';

const DAY = 86_400_000;

async function deleteWhereUid(db: Firestore, collection: string, uid: string): Promise<number> {
  let n = 0;
  for (;;) {
    const snap = await db.collection(collection).where('uid', '==', uid).limit(400).get();
    if (snap.empty) return n;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    n += snap.size;
  }
}

async function writeAll(db: Firestore, docs: { path: string; data: object }[]): Promise<void> {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) batch.set(db.doc(d.path), d.data);
    await batch.commit();
  }
}

async function main(): Promise<void> {
  useEmulatorEnv();
  await assertEmulators();
  const now = Date.now();

  // 1. Auth accounts (same uid as the dev login of portal and extension).
  const admin = await devGoogleSignIn(ADMIN_EMAIL);
  const uids: Record<string, string> = {};
  for (const p of PEOPLE) uids[p.key] = (await devGoogleSignIn(p.email)).uid;

  initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
  const db = getFirestore();

  // 2. config/org, profiles and invitations.
  const config: OrgConfig = {
    allowedDomains: [...DOMAINS],
    screenshotsEnabled: true,
    blurScreenshots: true,
    screenshotRetentionDays: 90,
    updatedAt: now,
    updatedBy: admin.uid,
  };
  // Only when missing: on re-runs (e.g. with emulators:persist) keep the settings the admin changed.
  const configRef = db.doc(`${COLLECTIONS.config}/org`);
  const configCreated = !(await configRef.get()).exists;
  if (configCreated) await configRef.set(config);
  // General working hours: also only when missing (keeps what the admin edited in the portal).
  const scheduleRef = db.doc(`${COLLECTIONS.config}/${SCHEDULE_CONFIG_DOC_ID}`);
  const scheduleCreated = !(await scheduleRef.get()).exists;
  if (scheduleCreated) {
    const schedule: ScheduleConfig = { ...SEED_SCHEDULE, holidays: [...SEED_SCHEDULE.holidays], updatedAt: now, updatedBy: admin.uid };
    await scheduleRef.set(schedule);
  }

  const existingCreatedAt = async (uid: string, fallback: number): Promise<number> => {
    const v = (await db.doc(`${COLLECTIONS.users}/${uid}`).get()).get('createdAt') as unknown;
    return typeof v === 'number' ? v : fallback;
  };
  const joined = now - 10 * DAY;
  const adminProfile: UserProfile = {
    email: ADMIN_EMAIL,
    displayName: 'Lukas (admin)',
    photoURL: null,
    role: 'admin',
    status: 'active',
    createdAt: await existingCreatedAt(admin.uid, now - 14 * DAY),
  };
  const docs: { path: string; data: object }[] = [{ path: `${COLLECTIONS.users}/${admin.uid}`, data: adminProfile }];
  for (const p of PEOPLE) {
    const uid = uids[p.key]!;
    const profile: UserProfile = {
      email: p.email,
      displayName: p.displayName,
      photoURL: null,
      role: 'member',
      status: 'active',
      createdAt: await existingCreatedAt(uid, joined),
      consentAcceptedAt: joined + 5 * 60_000,
      consentVersion: CONSENT_VERSION,
    };
    const invitation: Invitation = { email: p.email, invitedBy: admin.uid, invitedAt: joined - 3_600_000, status: 'accepted', acceptedAt: joined };
    docs.push({ path: `${COLLECTIONS.users}/${uid}`, data: profile }, { path: `${COLLECTIONS.invitations}/${p.email}`, data: invitation });
  }
  // Pending invitation: keep its date on re-runs (a new `invitedAt` would e-mail it again).
  const pendingRef = db.doc(`${COLLECTIONS.invitations}/${PENDING_INVITE}`);
  const prevPending = (await pendingRef.get()).data() as Invitation | undefined;
  const pending: Invitation = {
    email: PENDING_INVITE,
    invitedBy: admin.uid,
    invitedAt: prevPending?.status === 'pending' ? prevPending.invitedAt : now - DAY,
    status: 'pending',
  };
  docs.push({ path: pendingRef.path, data: pending });
  // Exceptions of the demo collaborators (their sessions below follow them).
  for (const [key, week] of Object.entries(SEED_EXCEPTIONS)) {
    const exception: PersonSchedule = { week, updatedAt: now, updatedBy: admin.uid };
    docs.push({ path: `${COLLECTIONS.schedules}/${uids[key]!}`, data: exception });
  }
  await writeAll(db, docs);

  // 3. Replace the demo collaborators' previous data (idempotent re-runs).
  let removed = 0;
  let removedFiles = 0;
  for (const p of PEOPLE) {
    const uid = uids[p.key]!;
    for (const c of [COLLECTIONS.activity, COLLECTIONS.sessions, COLLECTIONS.screenshots]) removed += await deleteWhereUid(db, c, uid);
    // Their sessions follow the seed's schedules: drop an exception made in the portal for the others.
    if (!SEED_EXCEPTIONS[p.key]) {
      const ref = db.doc(`${COLLECTIONS.schedules}/${uid}`);
      if ((await ref.get()).exists) {
        await ref.delete();
        removed++;
      }
    }
    for (const name of await storageObjects(`screenshots/${uid}/`)) {
      await deleteStorageObject(name);
      removedFiles++;
    }
  }

  // 4. Sessions and activity.
  const data = buildDataset(now, uids);
  await writeAll(db, [
    ...data.sessions.map((s) => ({ path: `${COLLECTIONS.sessions}/${s.id}`, data: s.data })),
    ...data.activity.map((a) => ({ path: `${COLLECTIONS.activity}/${activityDocId(a.uid, a.slotStart)}`, data: a })),
  ]);

  // 5. Blurred sample screenshots (Chromium renders the mock-ups).
  let shots = 0;
  const exe = findChromium();
  if (!exe) {
    console.warn(`Aviso: sin capturas de ejemplo (${NO_CHROMIUM})`);
  } else {
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    try {
      const images = await renderMockScreens(browser, data.shots.map((s) => s.task));
      for (const s of data.shots) {
        const storagePath = screenshotStoragePath(s.uid, s.takenAt, s.id);
        await uploadJpeg(storagePath, images.get(s.task)!);
        const meta: ScreenshotMeta = {
          uid: s.uid,
          sessionId: s.sessionId,
          takenAt: s.takenAt,
          storagePath,
          blurred: true,
          width: SHOT_WIDTH,
          height: SHOT_HEIGHT,
        };
        await db.doc(`${COLLECTIONS.screenshots}/${s.id}`).set(meta);
        shots++;
      }
    } finally {
      await browser.close();
    }
  }

  const open = data.sessions.filter((s) => s.data.endedAt === null).length;
  const meetingBlocks = data.activity.filter((a) => (a.meetingSeconds ?? 0) > 0).length;
  const meetingHours = data.activity.reduce((n, a) => n + (a.meetingSeconds ?? 0), 0) / 3600;
  console.log(
    [
      'Semilla cargada en los emuladores (proyecto demo-timetracking):',
      `  admin: ${ADMIN_EMAIL} (uid ${admin.uid})`,
      `  colaboradores: ${PEOPLE.map((p) => `${p.displayName} <${p.email}>`).join(', ')}`,
      `  invitaciones: ${PEOPLE.length} aceptadas, 1 pendiente (${PENDING_INVITE})`,
      configCreated ? '  config/org: creada (capturas difuminadas activas)' : '  config/org: ya existía, se dejó tal cual',
      scheduleCreated
        ? `  config/schedule: creado (L–J 09:00–18:30, colación 13:00–14:00; V 09:00–14:00; ${SEED_SCHEDULE.holidays.length} feriados de Chile; tolerancia ${SEED_SCHEDULE.toleranceMinutes} min; recordatorios activos)`
        : '  config/schedule: ya existía, se dejó tal cual',
      `  horario personalizado: ${Object.keys(SEED_EXCEPTIONS)
        .map((k) => PEOPLE.find((p) => p.key === k)?.displayName ?? k)
        .join(', ')} (media jornada 09:00–13:00, L–V)`,
      `  cumplimiento: atraso de Beto, salida anticipada de Ana, ausencia de Carla y tiempo fuera de horario (últimos días hábiles)`,
      `  jornadas: ${data.sessions.length} (${open} abierta ahora), bloques de actividad: ${data.activity.length}, capturas: ${shots}`,
      `  en reunión: ${meetingBlocks} bloques (${meetingHours.toFixed(1)} h; dailies de 30 min y una reunión de 1 h por persona a la semana)`,
      removed + removedFiles > 0 ? `  reemplazados de la corrida anterior: ${removed} documentos, ${removedFiles} archivos` : '',
      '  Portal dev: npm run dev -w portal → http://127.0.0.1:5173 → "Entrar (emulador)" con el correo del admin.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

await main().catch((err: unknown) => {
  console.error(`SEED FALLÓ: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
process.exit(0);
