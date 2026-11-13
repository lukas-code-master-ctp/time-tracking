/**
 * Everything the service worker needs from Firebase, behind one interface
 * (Firestore/Storage in firebase.ts, a fake in the unit tests).
 */
import type { Absence, AnnouncementRead, Celebration, OrgConfig, ScreenshotMeta, WithId } from '@timetracking/shared';
import type { Backend } from './sync';

export interface Remote extends Backend {
  /**
   * The person's open kiosk work day (`sessions where uid == && endedAt ==
   * null`, `source: 'kiosk'`), the newest one; null when there is none. Spec
   * 2026-11-10-marcaciones: the extension joins it to measure.
   */
  findOpenKioskSession(uid: string): Promise<{ id: string; startedAt: number } | null>;
  /** `getDoc(config/org)`; null when it does not exist. */
  fetchOrgConfig(): Promise<OrgConfig | null>;
  /**
   * `getDoc(config/schedule)` and `getDoc(schedules/{uid})`, raw (validated by
   * the caller); null when a doc does not exist. The exception is also null
   * when it cannot be read (rules older than 2026-09-30-horarios). Also
   * `attendanceSettings/{uid}` (spec 2026-11-10-marcaciones; null = missing
   * or unreadable).
   */
  fetchSchedule(uid: string): Promise<{ config: unknown; person: unknown; attendance?: unknown }>;
  /** `updateDoc(users/{uid}, { consentAcceptedAt, consentVersion })` (both, always). */
  acceptConsent(uid: string, at: number, version: string): Promise<void>;
  /** Uploads a JPEG to Storage. Storage rules never overwrite: a second upload fails with `permission-denied`. */
  uploadScreenshot(path: string, jpeg: Uint8Array<ArrayBuffer>): Promise<void>;
  /** True when the object exists (metadata GET; the owner can read it). */
  screenshotExists(path: string): Promise<boolean>;
  /** `setDoc(screenshots/{id}, meta)` with exactly the 7 fields of the rules. */
  putScreenshotMeta(id: string, meta: ScreenshotMeta): Promise<void>;
  /** The person's absences (`where uid ==`), spec 2026-10-22-solicitud-ausencias. */
  listAbsences(uid: string): Promise<WithId<Absence>[]>;
  /** New `absences/{autoId}` (a pending request); returns its id. Online only: not queued. */
  createAbsence(data: Absence): Promise<string>;
  /** Withdraws a request (the rules allow it only while pending). */
  deleteAbsence(id: string): Promise<void>;
  /**
   * Latest `announcements` for everyone or for `uid` (`audience
   * array-contains-any ['*', uid]`, `orderBy publishAt desc`, at most `max`),
   * raw (validated by the caller). Specs 2026-11-05-comunicados and 2026-11-13-grupos-y-comunicados-agendados.
   */
  listAnnouncements(uid: string, max: number): Promise<WithId<unknown>[]>;
  /** Ids of the announcements the person confirmed (`announcementReads where uid ==`). */
  listAnnouncementReads(uid: string): Promise<string[]>;
  /** `setDoc(announcementReads/{announcementId_uid})`. Online only: not queued. */
  putAnnouncementRead(docId: string, data: AnnouncementRead): Promise<void>;
  /**
   * Every valid `celebrations/{uid}` (spec 2026-11-05-cumpleanos-aniversarios);
   * `[]` while the rules are not deployed (permission-denied).
   */
  fetchCelebrations(): Promise<WithId<Celebration>[]>;
}
