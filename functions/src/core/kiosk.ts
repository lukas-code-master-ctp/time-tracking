/**
 * Business logic of the `kioskPunch` callable (spec 2026-11-10-marcaciones):
 * a tablet at the office entrance marks the entry ("Entrada") or the exit
 * ("Salida") of a person who types her RUT.
 *
 * - The device proves it is an allowed kiosk with a secret token: the
 *   portal stores only its SHA-256 as the id of `kiosks/{hash}` (revocable).
 * - The RUT is looked up in `attendanceSettings` (unique, normalized). The
 *   person must be active and allowed to mark on the kiosk (mode `kiosk` or
 *   `both`).
 * - Entry opens a `sessions` doc with `source: 'kiosk'` (no heartbeat), the
 *   same work day the reports read. If a work day is already open (from the
 *   kiosk or, with `both`, from the extension) it says so. A kiosk work day
 *   left open on a previous day (forgotten exit) is closed first, at the end
 *   of that day's schedule (`forgottenExitEnd`).
 * - Exit closes the open work day of today, whatever opened it.
 *
 * Kept free of the Functions runtime, like join.ts.
 */
import { createHash } from 'node:crypto';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  ATTENDANCE_PHOTO_MAX_BYTES,
  COLLECTIONS,
  attendancePhotoId,
  attendancePhotoPath,
  type AttendancePhoto,
  DEFAULT_TIME_ZONE,
  KIOSK_ID_RE,
  SCHEDULE_CONFIG_DOC_ID,
  allowsKiosk,
  dateKey,
  effectiveWeek,
  forgottenExitEnd,
  isSessionLive,
  normalizeRut,
  readAttendanceSettings,
  readKiosk,
  readPersonSchedule,
  readScheduleConfig,
  type Session,
  type UserProfile,
} from '@timetracking/shared';

export type PunchAction = 'in' | 'out';

export type KioskRejection =
  | 'bad-request'
  | 'kiosk-unknown'
  | 'kiosk-revoked'
  | 'rut-invalid'
  | 'rut-unknown'
  | 'rut-duplicated'
  | 'user-disabled'
  | 'kiosk-not-allowed'
  | 'already-in'
  | 'not-in';

export interface PunchResult {
  action: PunchAction;
  /** First name to greet the person ("¡Hola, Ana!"). */
  firstName: string;
  /** When it was marked. */
  at: number;
  /** Start of the work day (entry: = at; exit: the entry being closed). */
  startedAt: number;
  /** The kiosk's photo was saved (false: none sent, or it could not be saved). */
  photo: boolean;
}

export interface KioskDeps {
  db: Firestore;
  now: number;
  /** Storage bucket for the kiosk photos (spec: foto en el tótem). */
  bucket?: PhotoBucket;
}

/** Slice of the Storage bucket used here (`getStorage().bucket()`). */
export interface PhotoBucket {
  file(path: string): { save(data: Buffer, options: { contentType: string; resumable: boolean }): Promise<unknown> };
}

/**
 * The optional photo of the punch: a base64 JPEG (with or without the
 * `data:image/jpeg;base64,` prefix) of at most ATTENDANCE_PHOTO_MAX_BYTES.
 * Anything else counts as no photo (the mark is never refused for it).
 */
export function decodeKioskPhoto(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const b64 = raw.startsWith('data:image/jpeg;base64,') ? raw.slice('data:image/jpeg;base64,'.length) : raw;
  if (b64.length > Math.ceil((ATTENDANCE_PHOTO_MAX_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  // JPEG magic number.
  if (bytes.length < 4 || bytes.length > ATTENDANCE_PHOTO_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return null;
  }
  return bytes;
}

export function kioskIdOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function reject(reason: KioskRejection, message: string, extra: Record<string, unknown> = {}): never {
  const code = reason === 'bad-request' || reason === 'rut-invalid' ? 'invalid-argument' : reason === 'kiosk-unknown' || reason === 'kiosk-revoked' ? 'permission-denied' : 'failed-precondition';
  throw new HttpsError(code, message, { reason, ...extra });
}

function firstNameOf(profile: Pick<UserProfile, 'displayName' | 'email'>): string {
  const name = (profile.displayName || '').trim().split(/\s+/)[0];
  return name || profile.email.slice(0, profile.email.indexOf('@')) || '';
}

const TIME = new Intl.DateTimeFormat('es-CL', { timeZone: DEFAULT_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
const hhmm = (ms: number): string => TIME.format(new Date(ms));

export async function kioskPunchCore(deps: KioskDeps, input: unknown): Promise<PunchResult> {
  const { db, now } = deps;
  const data = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const token = typeof data.token === 'string' ? data.token : '';
  const action = data.action;
  if (token.length < 20 || token.length > 200 || (action !== 'in' && action !== 'out')) {
    reject('bad-request', 'Solicitud no válida.');
  }

  // 1. The device.
  const kioskId = kioskIdOf(token);
  if (!KIOSK_ID_RE.test(kioskId)) reject('kiosk-unknown', 'Este tótem no está activado.');
  const kioskRef = db.collection(COLLECTIONS.kiosks).doc(kioskId);
  const kiosk = readKiosk((await kioskRef.get()).data());
  if (!kiosk) reject('kiosk-unknown', 'Este tótem no está activado. Pide a administración un enlace nuevo.');
  if (kiosk.revokedAt !== null) reject('kiosk-revoked', 'Este tótem fue desactivado. Pide a administración un enlace nuevo.');

  // 2. The person.
  const rut = normalizeRut(data.rut);
  if (!rut) reject('rut-invalid', 'El RUT no es válido. Revisa el dígito verificador.');
  const matches = await db.collection(COLLECTIONS.attendanceSettings).where('rut', '==', rut).limit(2).get();
  if (matches.empty) reject('rut-unknown', 'No encontramos ese RUT. Pide a administración que lo registre.');
  if (matches.size > 1) reject('rut-duplicated', 'Ese RUT está registrado para más de una persona. Avisa a administración.');
  const settingsDoc = matches.docs[0]!;
  const uid = settingsDoc.id;
  const settings = readAttendanceSettings(settingsDoc.data());
  const profile = (await db.collection(COLLECTIONS.users).doc(uid).get()).data() as UserProfile | undefined;
  if (!settings || !profile) reject('rut-unknown', 'No encontramos ese RUT. Pide a administración que lo registre.');
  if (profile.status !== 'active') reject('user-disabled', 'Tu cuenta está desactivada. Habla con administración.');
  if (!allowsKiosk(settings.mode)) {
    reject('kiosk-not-allowed', 'Tu jornada se marca desde la extensión del navegador, no en el tótem.');
  }
  const firstName = firstNameOf(profile);

  // Schedule, only needed to close a forgotten exit of a previous day.
  const weekOf = async () => {
    const [general, person] = await Promise.all([
      db.collection(COLLECTIONS.config).doc(SCHEDULE_CONFIG_DOC_ID).get(),
      db.collection(COLLECTIONS.schedules).doc(uid).get(),
    ]);
    const config = readScheduleConfig(general.data());
    return { week: effectiveWeek(config, readPersonSchedule(person.data())), holidays: config?.holidays ?? [] };
  };
  const schedule = await weekOf();
  const today = dateKey(now, DEFAULT_TIME_ZONE);

  // 3. Open or close, in a transaction (two taps at once mark once).
  const result = await db.runTransaction(async (tx: Transaction) => {
    const openSnap = await tx.get(
      db.collection(COLLECTIONS.sessions).where('uid', '==', uid).where('endedAt', '==', null),
    );
    const open = openSnap.docs.map((d) => ({ ref: d.ref as DocumentReference, s: d.data() as Session }));
    // Live work day of today (an extension one with a recent heartbeat, or a kiosk one).
    const current = open
      .filter(({ s }) => dateKey(s.startedAt, DEFAULT_TIME_ZONE) === today && isSessionLive(s, now))
      .sort((a, b) => b.s.startedAt - a.s.startedAt)[0];
    // Kiosk work days of previous days never closed: forgotten exit.
    const forgotten = open.filter(({ s }) => s.source === 'kiosk' && dateKey(s.startedAt, DEFAULT_TIME_ZONE) !== today);

    if (action === 'in') {
      if (current) {
        reject('already-in', `Ya marcaste tu entrada a las ${hhmm(current.s.startedAt)}.`, { startedAt: current.s.startedAt });
      }
      for (const { ref, s } of forgotten) {
        const end = Math.min(forgottenExitEnd(s, schedule.week, schedule.holidays), now);
        tx.update(ref, { endedAt: end, endReason: 'auto', lastHeartbeatAt: Math.max(s.lastHeartbeatAt, end) });
      }
      const ref = db.collection(COLLECTIONS.sessions).doc();
      const session: Session = {
        uid,
        startedAt: now,
        endedAt: null,
        endReason: null,
        lastHeartbeatAt: now,
        source: 'kiosk',
        kioskId,
      };
      tx.set(ref, session);
      tx.update(kioskRef, { lastUsedAt: now });
      return { action: 'in' as const, firstName, at: now, startedAt: now, sessionId: ref.id };
    }

    if (!current) reject('not-in', 'No tienes una entrada marcada hoy. Marca primero tu entrada.');
    tx.update(current.ref, {
      endedAt: now,
      endReason: 'manual',
      lastHeartbeatAt: Math.max(current.s.lastHeartbeatAt, now),
      closedByKioskId: kioskId,
    });
    tx.update(kioskRef, { lastUsedAt: now });
    return { action: 'out' as const, firstName, at: now, startedAt: current.s.startedAt, sessionId: current.ref.id };
  });

  // 4. The photo, after the mark (a failure here never undoes it).
  const { sessionId, ...punch } = result;
  const jpeg = decodeKioskPhoto(data.photo);
  let photo = false;
  if (jpeg && deps.bucket) {
    try {
      const date = dateKey(now, DEFAULT_TIME_ZONE);
      const path = attendancePhotoPath(uid, date, sessionId, punch.action);
      await deps.bucket.file(path).save(jpeg, { contentType: 'image/jpeg', resumable: false });
      const doc: AttendancePhoto = { uid, sessionId, kind: punch.action, at: now, date, kioskId, path };
      await db.collection(COLLECTIONS.attendancePhotos).doc(attendancePhotoId(sessionId, punch.action)).set(doc);
      photo = true;
    } catch (err) {
      console.warn('[kioskPunch] no se pudo guardar la foto', err);
    }
  }
  return { ...punch, photo };
}
