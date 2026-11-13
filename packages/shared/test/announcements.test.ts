import { describe, expect, it } from 'vitest';
import {
  announcementAudience,
  announcementPublishAt,
  announcementReadId,
  isAnnouncementFor,
  isForEveryone,
  isScheduled,
  readAnnouncement,
  readSummary,
  validateAnnouncement,
  validateAnnouncementDelivery,
  type Announcement,
} from '../src/index.js';

describe('announcements (spec 2026-11-05-comunicados)', () => {
  it('read ids are announcementId_uid', () => {
    expect(announcementReadId('a1', 'u1')).toBe('a1_u1');
    expect(() => announcementReadId('', 'u1')).toThrow();
    expect(() => announcementReadId('a/1', 'u1')).toThrow();
  });

  it('validates what the admin writes', () => {
    expect(validateAnnouncement({ title: 'Aviso', body: 'Hola', authorName: 'RRHH' })).toEqual([]);
    expect(validateAnnouncement({ title: '  ', body: '', authorName: '' }).map((i) => i.path)).toEqual(['title', 'body', 'authorName']);
    expect(validateAnnouncement({ title: 'x'.repeat(121), body: 'x'.repeat(4001), authorName: 'x'.repeat(81) })).toHaveLength(3);
  });

  it('reads only well-formed documents', () => {
    const ok = { title: 't', body: 'b', authorName: 'RRHH', createdAt: 1, createdBy: 'a', archivedAt: null };
    expect(readAnnouncement(ok)).toEqual(ok);
    expect(readAnnouncement({ ...ok, extra: 1 })).toEqual(ok);
    expect(readAnnouncement({ ...ok, archivedAt: 'x' })).toBeNull();
    expect(readAnnouncement({ ...ok, title: 3 })).toBeNull();
    expect(readAnnouncement(null)).toBeNull();
  });

  it('splits the people into read (oldest first) and unread', () => {
    const people = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    const s = readSummary('a1', people, [
      { announcementId: 'a1', uid: 'u3', readAt: 5 },
      { announcementId: 'a1', uid: 'u1', readAt: 9 },
      { announcementId: 'a2', uid: 'u2', readAt: 1 },
    ]);
    expect(s.read.map((r) => r.person.id)).toEqual(['u3', 'u1']);
    expect(s.unread.map((p) => p.id)).toEqual(['u2']);
  });
});

describe('scheduled announcements for groups (spec 2026-11-13-grupos-y-comunicados-agendados)', () => {
  const base: Announcement = { title: 't', body: 'b', authorName: 'RRHH', createdAt: 100, createdBy: 'a', archivedAt: null };

  it('old announcements go to everyone right away', () => {
    expect(announcementPublishAt(base)).toBe(100);
    expect(announcementAudience(base)).toEqual(['*']);
    expect(isAnnouncementFor(base, 'u1')).toBe(true);
    expect(isScheduled(base, 50)).toBe(true);
    expect(isScheduled(base, 100)).toBe(false);
  });

  it('a group announcement is only for its audience', () => {
    const a = { ...base, publishAt: 500, audience: ['u1', 'u2'], groupIds: ['g1'] };
    expect(isAnnouncementFor(a, 'u1')).toBe(true);
    expect(isAnnouncementFor(a, 'u3')).toBe(false);
    expect(isForEveryone(a)).toBe(false);
    expect(readAnnouncement(a)).toEqual(a);
    expect(readAnnouncement({ ...a, audience: [] })).toBeNull();
    expect(readAnnouncement({ ...a, publishAt: 'x' })).toBeNull();
  });

  it('validates when and to whom', () => {
    const now = 1_000_000;
    expect(validateAnnouncementDelivery({ publishAt: null, groupIds: null, members: [] }, now)).toEqual([]);
    expect(validateAnnouncementDelivery({ publishAt: now + 60_000, groupIds: ['g'], members: ['u'] }, now)).toEqual([]);
    expect(validateAnnouncementDelivery({ publishAt: now - 1, groupIds: null, members: [] }, now)[0]?.path).toBe('publishAt');
    expect(validateAnnouncementDelivery({ publishAt: Number.NaN, groupIds: null, members: [] }, now)[0]?.path).toBe('publishAt');
    expect(validateAnnouncementDelivery({ publishAt: now + 400 * 86_400_000, groupIds: null, members: [] }, now)).toHaveLength(1);
    expect(validateAnnouncementDelivery({ publishAt: null, groupIds: [], members: [] }, now)[0]?.message).toBe('Elige al menos un grupo.');
    expect(validateAnnouncementDelivery({ publishAt: null, groupIds: ['g'], members: [] }, now)[0]?.message).toBe('Los grupos elegidos no tienen personas.');
  });
});
