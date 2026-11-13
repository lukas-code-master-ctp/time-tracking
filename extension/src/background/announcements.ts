/**
 * Internal announcements in the extension (spec 2026-11-05-comunicados).
 *
 * The worker reads the latest announcements and the person's read
 * confirmations at the same moments as `config/org` (worker start, the
 * 5-minute refresh of the pulse, the schedule alarm, a sign-in) and when the
 * popup opens. Each announcement not confirmed yet shows one notification
 * (once: `notified`) and a card in the popup until the person presses
 * "Confirmo que lo leí", which writes `announcementReads/{id_uid}` online.
 * Pure helpers; the wiring is in app.ts.
 *
 * Since 0.2.29 (spec 2026-11-13-grupos-y-comunicados-agendados) the read asks
 * only for the announcements addressed to everyone or to this person
 * (`audience`), and a scheduled one is kept in the cache but neither shown
 * nor notified until its `publishAt` passes.
 */
import { announcementPublishAt, type Announcement, type WithId } from '@timetracking/shared';

/** Latest announcements read (older ones are not shown in the extension). */
export const ANNOUNCEMENTS_LIMIT = 30;
/** The popup asks for a fresh read when the cache is older than this. */
export const ANNOUNCEMENTS_POPUP_REFRESH_MS = 60_000;

const NOTIFICATION_PREFIX = 'announcement:';

/** What the extension keeps of one announcement. */
export interface CachedAnnouncement {
  id: string;
  title: string;
  body: string;
  authorName: string;
  createdAt: number;
  /** When it can be shown (createdAt in caches before 0.2.29). */
  publishAt: number;
}

/** `tt.meta.announcements`: last read of the signed-in user. Missing before 0.2.14. */
export interface AnnouncementCache {
  uid: string;
  /** Not archived, newest first. */
  items: CachedAnnouncement[];
  /** Ids the person confirmed (from Firestore, plus the ones confirmed on this device). */
  readIds: string[];
  /** Ids already notified on this device (one notification per announcement). */
  notified: string[];
  fetchedAt: number;
}

function isCached(v: unknown): v is CachedAnnouncement {
  if (!v || typeof v !== 'object') return false;
  const a = v as CachedAnnouncement;
  return (
    typeof a.id === 'string' &&
    typeof a.title === 'string' &&
    typeof a.body === 'string' &&
    typeof a.authorName === 'string' &&
    typeof a.createdAt === 'number'
  );
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function announcementCacheFromJSON(v: unknown): AnnouncementCache | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<AnnouncementCache>;
  if (typeof c.uid !== 'string' || typeof c.fetchedAt !== 'number' || !Array.isArray(c.items)) return null;
  const items = c.items.filter(isCached).map((a) => ({ ...a, publishAt: typeof a.publishAt === 'number' ? a.publishAt : a.createdAt }));
  return { uid: c.uid, items, readIds: strings(c.readIds), notified: strings(c.notified), fetchedAt: c.fetchedAt };
}

/**
 * New cache after a read. `previous` keeps the notified ids (and the
 * confirmations made on this device that Firestore did not return yet) when
 * it is the same person.
 */
export function mergeAnnouncements(
  previous: AnnouncementCache | null,
  uid: string,
  list: readonly WithId<Announcement>[],
  readIds: readonly string[],
  at: number,
): AnnouncementCache {
  const same = previous?.uid === uid ? previous : null;
  const items = list
    .filter((a) => a.archivedAt === null)
    .map((a) => ({ id: a.id, title: a.title, body: a.body, authorName: a.authorName, createdAt: a.createdAt, publishAt: announcementPublishAt(a) }))
    .sort((a, b) => b.publishAt - a.publishAt);
  const ids = new Set(items.map((a) => a.id));
  // Only ids still listed are kept, so the arrays do not grow forever.
  const read = new Set([...readIds, ...(same?.readIds ?? [])].filter((id) => ids.has(id)));
  const notified = (same?.notified ?? []).filter((id) => ids.has(id));
  return { uid, items, readIds: [...read], notified, fetchedAt: at };
}

/**
 * Announcements already sent (`publishAt <= now`) that the person has not
 * confirmed, oldest first (the popup shows them in order).
 */
export function unreadAnnouncements(cache: AnnouncementCache | null, uid: string | null, now: number): CachedAnnouncement[] {
  if (!cache || !uid || cache.uid !== uid) return [];
  const read = new Set(cache.readIds);
  return cache.items.filter((a) => a.publishAt <= now && !read.has(a.id)).reverse();
}

/** Unread announcements not notified yet on this device (oldest first). */
export function toNotify(cache: AnnouncementCache | null, uid: string | null, now: number): CachedAnnouncement[] {
  const notified = new Set(cache?.notified ?? []);
  return unreadAnnouncements(cache, uid, now).filter((a) => !notified.has(a.id));
}

export function announcementNotificationId(id: string): string {
  return `${NOTIFICATION_PREFIX}${id}`;
}

/** Id of the announcement of a notification, or null when it is something else. */
export function parseAnnouncementNotificationId(notificationId: string): string | null {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return null;
  const id = notificationId.slice(NOTIFICATION_PREFIX.length);
  return id === '' ? null : id;
}

/** Text of the notification: one announcement, or a summary when several arrive together. */
export function announcementNotificationText(fresh: readonly CachedAnnouncement[]): { title: string; message: string } {
  if (fresh.length === 1) {
    const a = fresh[0]!;
    const body = a.body.replace(/\s+/g, ' ').trim();
    return { title: `${a.authorName}: ${a.title}`, message: body.length > 160 ? `${body.slice(0, 157)}…` : body };
  }
  return {
    title: `Tienes ${fresh.length} comunicados nuevos`,
    message: 'Ábrelos desde el ícono de la extensión y confirma que los leíste.',
  };
}
