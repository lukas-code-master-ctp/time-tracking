/**
 * Business logic of the `draftDailyReport` callable (spec
 * 2026-11-13-minuta-diaria): a person asked for the daily report sends the
 * audio she recorded in the extension; the AI model transcribes it and writes
 * a draft of the report, which she reviews before sending it herself.
 *
 * - Only an active person in the field (`users.workplace`) or in one of the groups of
 *   `config/org.dailyReportGroupIds` (with the report on) may ask: the model costs money.
 * - At most `DAILY_REPORT_MAX_DRAFTS_PER_DAY` drafts per person and day
 *   (`dailyReportDrafts/{uid_date}`, counted in a transaction before calling the model).
 * - The audio is never stored: it goes to the model and is dropped.
 *
 * Kept free of the Functions runtime (the model call is injected), like join.ts.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  COLLECTIONS,
  DAILY_REPORT_MAX_AUDIO_BYTES,
  DAILY_REPORT_MAX_DRAFTS_PER_DAY,
  DEFAULT_TIME_ZONE,
  ORG_CONFIG_DOC_ID,
  dailyReportAudioType,
  dailyReportDocId,
  dateKey,
  readDailyReportSettings,
  requiresDailyReport,
  type DailyReportDraft,
  type DailyReportDraftCount,
  type OrgConfig,
  type UserProfile,
} from '@timetracking/shared';

/** Transcribes and drafts (Vertex AI in prod, a fake in tests and the emulator). */
export type DraftModel = (audio: { base64: string; mimeType: string }) => Promise<DailyReportDraft>;

export interface DraftDeps {
  db: Firestore;
  now: number;
  model: DraftModel;
}

export interface DraftRequest {
  audio?: unknown;
  mimeType?: unknown;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded size of a base64 string. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Ids of the groups whose `memberUids` contain `uid` (collection of the groups feature). */
async function groupIdsOf(db: Firestore, uid: string): Promise<string[]> {
  const snap = await db.collection(COLLECTIONS.groups).where('memberUids', 'array-contains', uid).get();
  return snap.docs.map((d) => d.id);
}

export async function draftDailyReportCore(
  deps: DraftDeps,
  uid: string | null | undefined,
  req: DraftRequest | null | undefined,
): Promise<DailyReportDraft> {
  if (!uid) throw new HttpsError('unauthenticated', 'Inicia sesión.');
  const mimeType = dailyReportAudioType(req?.mimeType);
  const audio = req?.audio;
  if (!mimeType || typeof audio !== 'string' || audio.length % 4 !== 0 || !BASE64_RE.test(audio)) {
    throw new HttpsError('invalid-argument', 'El audio no es válido.');
  }
  const bytes = base64Bytes(audio);
  if (bytes < 1000) throw new HttpsError('invalid-argument', 'El audio está vacío.');
  if (bytes > DAILY_REPORT_MAX_AUDIO_BYTES) throw new HttpsError('invalid-argument', 'El audio es demasiado largo.');

  const { db, now } = deps;
  const [userSnap, orgSnap, groups] = await Promise.all([
    db.collection(COLLECTIONS.users).doc(uid).get(),
    db.collection(COLLECTIONS.config).doc(ORG_CONFIG_DOC_ID).get(),
    groupIdsOf(db, uid),
  ]);
  const user = userSnap.data() as UserProfile | undefined;
  if (!user || user.status !== 'active') throw new HttpsError('permission-denied', 'Tu cuenta no está activa.');
  const settings = readDailyReportSettings(orgSnap.data() as OrgConfig | undefined);
  if (!requiresDailyReport(settings, groups, user)) {
    throw new HttpsError('failed-precondition', 'Tu empresa no te pidió la minuta diaria.');
  }

  const date = dateKey(now, DEFAULT_TIME_ZONE);
  const counter = db.collection(COLLECTIONS.dailyReportDrafts).doc(dailyReportDocId(uid, date));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(counter);
    const count = (snap.data() as DailyReportDraftCount | undefined)?.count ?? 0;
    if (count >= DAILY_REPORT_MAX_DRAFTS_PER_DAY) {
      throw new HttpsError('resource-exhausted', 'Llegaste al máximo de audios de hoy. Escribe la minuta.');
    }
    const next: DailyReportDraftCount = { uid, date, count: count + 1, updatedAt: now };
    tx.set(counter, next);
  });

  let draft: DailyReportDraft;
  try {
    draft = await deps.model({ base64: audio, mimeType });
  } catch (err) {
    console.error('[draftDailyReport] el modelo falló', err);
    throw new HttpsError('unavailable', 'No se pudo transcribir el audio. Intenta de nuevo o escribe la minuta.');
  }
  return draft;
}
