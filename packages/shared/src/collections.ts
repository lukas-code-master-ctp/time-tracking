/** Firestore collection names and document id helpers. */

export const COLLECTIONS = {
  config: 'config',
  invitations: 'invitations',
  users: 'users',
  sessions: 'sessions',
  activity: 'activity',
  screenshots: 'screenshots',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** Document id of the single organization config: `config/org`. */
export const ORG_CONFIG_DOC_ID = 'org';

/** Root folder of screenshots in Cloud Storage. */
export const SCREENSHOTS_STORAGE_ROOT = 'screenshots';

/** Canonical key for an email (used as `invitations/{emailKey}`). */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** Deterministic, idempotent id of an activity block: `uid_slotStartMs`. */
export function activityDocId(uid: string, slotStart: number): string {
  if (!uid) throw new Error('activityDocId: uid is required');
  if (!Number.isSafeInteger(slotStart) || slotStart < 0) {
    throw new Error(`activityDocId: invalid slotStart ${String(slotStart)}`);
  }
  return `${uid}_${slotStart}`;
}

/** Inverse of {@link activityDocId}. Returns null when the id is malformed. */
export function parseActivityDocId(id: string): { uid: string; slotStart: number } | null {
  const idx = id.lastIndexOf('_');
  if (idx <= 0 || idx === id.length - 1) return null;
  const digits = id.slice(idx + 1);
  if (!/^\d+$/.test(digits)) return null;
  const slotStart = Number(digits);
  if (!Number.isSafeInteger(slotStart)) return null;
  return { uid: id.slice(0, idx), slotStart };
}

/** Default time zone used to group data by calendar day. */
export const DEFAULT_TIME_ZONE = 'America/Santiago';

/** Calendar date `YYYY-MM-DD` of an instant in the given IANA time zone. */
export function dateKey(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Storage path of a screenshot: `screenshots/{uid}/{YYYY-MM-DD}/{id}.jpg`. */
export function screenshotStoragePath(
  uid: string,
  takenAt: number,
  id: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  if (!uid || !id) throw new Error('screenshotStoragePath: uid and id are required');
  if (uid.includes('/') || id.includes('/')) {
    throw new Error('screenshotStoragePath: uid and id must not contain "/"');
  }
  return `${SCREENSHOTS_STORAGE_ROOT}/${uid}/${dateKey(takenAt, timeZone)}/${id}.jpg`;
}
