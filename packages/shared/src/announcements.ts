/**
 * Internal announcements (spec 2026-11-05-comunicados): an admin publishes
 * them in the portal, the extension shows them to every active person until
 * they confirm the reading. Pure.
 */

import type { ScheduleIssue } from './schedule.js';
import type { Announcement, AnnouncementRead } from './types.js';

/** Same limits as `firestore.rules`. */
export const MAX_ANNOUNCEMENT_TITLE = 120;
export const MAX_ANNOUNCEMENT_BODY = 4000;
export const MAX_ANNOUNCEMENT_AUTHOR = 80;

/** Deterministic id of a read confirmation: `announcementId_uid` (one per person and announcement). */
export function announcementReadId(announcementId: string, uid: string): string {
  if (!announcementId || !uid) throw new Error('announcementReadId: announcementId and uid are required');
  if (announcementId.includes('/') || uid.includes('/')) throw new Error('announcementReadId: ids must not contain "/"');
  return `${announcementId}_${uid}`;
}

/** Problems of what the admin writes ([] = valid). Messages in Spanish, for the portal. */
export function validateAnnouncement(a: Pick<Announcement, 'title' | 'body' | 'authorName'>): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  const body = typeof a.body === 'string' ? a.body.trim() : '';
  if (title === '') issues.push({ path: 'title', message: 'Escribe un título.' });
  else if (title.length > MAX_ANNOUNCEMENT_TITLE) {
    issues.push({ path: 'title', message: `El título puede tener hasta ${MAX_ANNOUNCEMENT_TITLE} caracteres.` });
  }
  if (body === '') issues.push({ path: 'body', message: 'Escribe el mensaje.' });
  else if (body.length > MAX_ANNOUNCEMENT_BODY) {
    issues.push({ path: 'body', message: `El mensaje puede tener hasta ${MAX_ANNOUNCEMENT_BODY} caracteres.` });
  }
  if (typeof a.authorName !== 'string' || a.authorName.trim() === '' || a.authorName.trim().length > MAX_ANNOUNCEMENT_AUTHOR) {
    issues.push({ path: 'authorName', message: `Indica quién lo envía (hasta ${MAX_ANNOUNCEMENT_AUTHOR} caracteres).` });
  }
  return issues;
}

/** Valid announcement document read from Firestore, or null (ignored by the extension). */
export function readAnnouncement(raw: unknown): Announcement | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.title !== 'string' || typeof d.body !== 'string' || typeof d.authorName !== 'string') return null;
  if (typeof d.createdAt !== 'number' || typeof d.createdBy !== 'string') return null;
  if (d.archivedAt !== null && typeof d.archivedAt !== 'number') return null;
  return {
    title: d.title,
    body: d.body,
    authorName: d.authorName,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    archivedAt: d.archivedAt,
  };
}

/** Who read an announcement and who not yet, among `people` (the active ones). */
export function readSummary<P extends { id: string }>(
  announcementId: string,
  people: readonly P[],
  reads: readonly AnnouncementRead[],
): { read: { person: P; readAt: number }[]; unread: P[] } {
  const at = new Map<string, number>();
  for (const r of reads) if (r.announcementId === announcementId) at.set(r.uid, r.readAt);
  const read: { person: P; readAt: number }[] = [];
  const unread: P[] = [];
  for (const person of people) {
    const t = at.get(person.id);
    if (t === undefined) unread.push(person);
    else read.push({ person, readAt: t });
  }
  read.sort((a, b) => a.readAt - b.readAt);
  return { read, unread };
}
