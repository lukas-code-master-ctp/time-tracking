/**
 * Everything the service worker needs from Firebase, behind one interface
 * (Firestore/Storage in firebase.ts, a fake in the unit tests).
 */
import type { OrgConfig, ScreenshotMeta } from '@timetracking/shared';
import type { Backend } from './sync';

export interface Remote extends Backend {
  /** `getDoc(config/org)`; null when it does not exist. */
  fetchOrgConfig(): Promise<OrgConfig | null>;
  /**
   * `getDoc(config/schedule)` and `getDoc(schedules/{uid})`, raw (validated by
   * the caller); null when a doc does not exist. The exception is also null
   * when it cannot be read (rules older than 2026-09-30-horarios).
   */
  fetchSchedule(uid: string): Promise<{ config: unknown; person: unknown }>;
  /** `updateDoc(users/{uid}, { consentAcceptedAt, consentVersion })` (both, always). */
  acceptConsent(uid: string, at: number, version: string): Promise<void>;
  /** Uploads a JPEG to Storage. Storage rules never overwrite: a second upload fails with `permission-denied`. */
  uploadScreenshot(path: string, jpeg: Uint8Array<ArrayBuffer>): Promise<void>;
  /** True when the object exists (metadata GET; the owner can read it). */
  screenshotExists(path: string): Promise<boolean>;
  /** `setDoc(screenshots/{id}, meta)` with exactly the 7 fields of the rules. */
  putScreenshotMeta(id: string, meta: ScreenshotMeta): Promise<void>;
}
