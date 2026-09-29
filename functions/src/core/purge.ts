/**
 * Screenshot retention (spec section 6, `purgeOldScreenshots`): deletes the
 * Storage file and the `screenshots/{id}` doc of every capture older than
 * `config/org.screenshotRetentionDays` (default 90). Hours and activity are kept.
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  DEFAULT_SCREENSHOT_RETENTION_DAYS,
  ORG_CONFIG_DOC_ID,
  SCREENSHOTS_STORAGE_ROOT,
  type ScreenshotMeta,
} from '@timetracking/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal slice of a Cloud Storage bucket, so tests can inject fakes. */
export interface BucketLike {
  file(path: string): { delete(options?: { ignoreNotFound?: boolean }): Promise<unknown> };
}

export interface PurgeDeps {
  db: Firestore;
  bucket: BucketLike;
  now: number;
  /** Docs per page (and per batched delete). Max 500. */
  pageSize?: number;
  logger?: { warn(message: string, data?: unknown): void };
}

export interface PurgeResult {
  retentionDays: number;
  cutoff: number;
  deletedDocs: number;
  deletedFiles: number;
  /** Docs kept because their file could not be deleted (retried next run). */
  failed: number;
}

export function retentionDaysOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_SCREENSHOT_RETENTION_DAYS;
}

/** A doc may only point at a file inside its owner's screenshot folder. */
function isOwnScreenshotPath(meta: Partial<ScreenshotMeta>): meta is ScreenshotMeta {
  return (
    typeof meta.storagePath === 'string' &&
    typeof meta.uid === 'string' &&
    meta.uid !== '' &&
    meta.storagePath.startsWith(`${SCREENSHOTS_STORAGE_ROOT}/${meta.uid}/`) &&
    !meta.storagePath.includes('..')
  );
}

export async function purgeOldScreenshotsCore(deps: PurgeDeps): Promise<PurgeResult> {
  const { db, bucket, now } = deps;
  const pageSize = Math.min(Math.max(deps.pageSize ?? 200, 1), 500);

  const configSnap = await db.collection(COLLECTIONS.config).doc(ORG_CONFIG_DOC_ID).get();
  const retentionDays = retentionDaysOf(configSnap.get('screenshotRetentionDays'));
  const cutoff = now - retentionDays * DAY_MS;

  const result: PurgeResult = { retentionDays, cutoff, deletedDocs: 0, deletedFiles: 0, failed: 0 };
  const base = db
    .collection(COLLECTIONS.screenshots)
    .where('takenAt', '<', cutoff)
    .orderBy('takenAt')
    .limit(pageSize);

  let last: DocumentSnapshot | undefined;
  for (;;) {
    const page = await (last ? base.startAfter(last) : base).get();
    if (page.empty) break;
    last = page.docs[page.docs.length - 1];

    const deletable = await Promise.all(
      page.docs.map(async (doc) => {
        const meta = doc.data() as Partial<ScreenshotMeta>;
        if (!isOwnScreenshotPath(meta)) {
          // Metadata without a valid file: nothing to delete in Storage.
          return doc.ref;
        }
        try {
          await bucket.file(meta.storagePath).delete({ ignoreNotFound: true });
          result.deletedFiles += 1;
          return doc.ref;
        } catch (err) {
          result.failed += 1;
          deps.logger?.warn('No se pudo borrar la captura; se reintenta mañana', {
            id: doc.id,
            storagePath: meta.storagePath,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );

    const batch = db.batch();
    let n = 0;
    for (const ref of deletable) {
      if (ref) {
        batch.delete(ref);
        n += 1;
      }
    }
    if (n > 0) await batch.commit();
    result.deletedDocs += n;

    if (page.size < pageSize) break;
  }
  return result;
}
