import { describe, expect, it } from 'vitest';
import { announcementReadId, readAnnouncement, readSummary, validateAnnouncement } from '../src/index.js';

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
