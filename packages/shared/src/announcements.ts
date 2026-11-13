/**
 * Internal announcements (spec 2026-11-05-comunicados): an admin publishes
 * them in the portal, the extension shows them to every active person until
 * they confirm the reading. Since 0.2.29 (spec 2026-11-13-grupos-y-comunicados-agendados)
 * they can be scheduled (`publishAt`) and sent to groups (`audience`). Pure.
 */

import type { ScheduleIssue } from './schedule.js';
import type { Announcement, AnnouncementRead } from './types.js';

/** Same limits as `firestore.rules`. */
export const MAX_ANNOUNCEMENT_TITLE = 120;
export const MAX_ANNOUNCEMENT_BODY = 4000;
export const MAX_ANNOUNCEMENT_AUTHOR = 80;
/** Members copied into `audience` (same as a group). */
export const MAX_ANNOUNCEMENT_AUDIENCE = 500;
/** Groups chosen for one announcement. */
export const MAX_ANNOUNCEMENT_GROUPS = 50;
/** How far ahead an announcement can be scheduled. */
export const MAX_ANNOUNCEMENT_SCHEDULE_MS = 366 * 24 * 60 * 60 * 1000;
/** `audience` entry meaning "every active person". */
export const ANNOUNCEMENT_EVERYONE = '*';

/** When it reaches the extension (`createdAt` for announcements before 0.2.29). */
export function announcementPublishAt(a: Pick<Announcement, 'createdAt' | 'publishAt'>): number {
  return typeof a.publishAt === 'number' ? a.publishAt : a.createdAt;
}

/** Who sees it: `['*']` or uids (`['*']` for announcements before 0.2.29). */
export function announcementAudience(a: Pick<Announcement, 'audience'>): string[] {
  return Array.isArray(a.audience) && a.audience.length > 0 ? a.audience : [ANNOUNCEMENT_EVERYONE];
}

/** True when it goes to every active person. */
export function isForEveryone(a: Pick<Announcement, 'audience'>): boolean {
  return announcementAudience(a).includes(ANNOUNCEMENT_EVERYONE);
}

/** True when `uid` is among its recipients. */
export function isAnnouncementFor(a: Pick<Announcement, 'audience'>, uid: string): boolean {
  const audience = announcementAudience(a);
  return audience.includes(ANNOUNCEMENT_EVERYONE) || audience.includes(uid);
}

/** True while it waits for its scheduled time (not shown in the extension yet). */
export function isScheduled(a: Pick<Announcement, 'createdAt' | 'publishAt'>, now: number): boolean {
  return announcementPublishAt(a) > now;
}

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

/**
 * Problems of when and to whom ([] = valid). `publishAt` null = right away;
 * `groupIds` null = everyone, otherwise at least one group whose members
 * (`members`, already resolved) are at most MAX_ANNOUNCEMENT_AUDIENCE.
 */
export function validateAnnouncementDelivery(
  d: { publishAt: number | null; groupIds: readonly string[] | null; members: readonly string[] },
  now: number,
): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  if (d.publishAt !== null) {
    if (!Number.isFinite(d.publishAt)) issues.push({ path: 'publishAt', message: 'Elige la fecha y la hora del envío.' });
    else if (d.publishAt <= now) issues.push({ path: 'publishAt', message: 'La fecha y hora del envío ya pasó. Elige una futura o envíalo ahora.' });
    else if (d.publishAt > now + MAX_ANNOUNCEMENT_SCHEDULE_MS) issues.push({ path: 'publishAt', message: 'Se puede programar hasta con un año de anticipación.' });
  }
  if (d.groupIds !== null) {
    if (d.groupIds.length === 0) issues.push({ path: 'groupIds', message: 'Elige al menos un grupo.' });
    else if (d.groupIds.length > MAX_ANNOUNCEMENT_GROUPS) issues.push({ path: 'groupIds', message: `Puedes elegir hasta ${MAX_ANNOUNCEMENT_GROUPS} grupos.` });
    else if (d.members.length === 0) issues.push({ path: 'groupIds', message: 'Los grupos elegidos no tienen personas.' });
    else if (d.members.length > MAX_ANNOUNCEMENT_AUDIENCE) {
      issues.push({ path: 'groupIds', message: `Un comunicado por grupos puede llegar a hasta ${MAX_ANNOUNCEMENT_AUDIENCE} personas. Para más, envíalo a todo el equipo.` });
    }
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
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (d.publishAt !== undefined && typeof d.publishAt !== 'number') return null;
  if (d.audience !== undefined && (!strings(d.audience) || d.audience.length === 0)) return null;
  if (d.groupIds !== undefined && !strings(d.groupIds)) return null;
  const out: Announcement = {
    title: d.title,
    body: d.body,
    authorName: d.authorName,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    archivedAt: d.archivedAt,
  };
  if (typeof d.publishAt === 'number') out.publishAt = d.publishAt;
  if (strings(d.audience)) out.audience = [...d.audience];
  if (strings(d.groupIds)) out.groupIds = [...d.groupIds];
  return out;
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
