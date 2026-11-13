import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_MS, slotStartOf, type Announcement } from '@timetracking/shared';
import { announcementCacheFromJSON, mergeAnnouncements } from '../src/background/announcements';
import { isPopupRequest } from '../src/messages';
import { createHarness, type Harness } from './fakes';

// Spec 2026-11-05-comunicados: announcements from the portal reach the extension.
const NOW = slotStartOf(1_790_000_000_000) + SLOT_MS;

function ann(overrides: Partial<Announcement> = {}): Announcement {
  const createdAt = overrides.createdAt ?? NOW - 60_000;
  return {
    title: 'Nuevo reglamento',
    body: 'Lee el reglamento interno actualizado.',
    authorName: 'Recursos Humanos',
    createdAt,
    createdBy: 'admin',
    archivedAt: null,
    publishAt: createdAt,
    audience: ['*'],
    groupIds: [],
    ...overrides,
  };
}

describe('internal announcements (spec 2026-11-05-comunicados)', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates the messages', () => {
    expect(isPopupRequest({ type: 'announcements.ack', id: 'n1' })).toBe(true);
    expect(isPopupRequest({ type: 'announcements.ack', id: '' })).toBe(false);
    expect(isPopupRequest({ type: 'announcements.ack' })).toBe(false);
  });

  it('unread announcements are notified once and shown oldest first; archived ones are not', async () => {
    h.backend.announcements.set('n1', ann({ title: 'Primero', createdAt: NOW - 120_000 }));
    h.backend.announcements.set('n2', ann({ title: 'Segundo' }));
    h.backend.announcements.set('old', ann({ title: 'Archivado', archivedAt: NOW - 1 }));
    await h.app.refreshAnnouncements(0);
    const shown = [...h.chrome.world.notifications.entries()].filter(([id]) => id.startsWith('announcement:'));
    expect(shown).toHaveLength(1);
    expect(shown[0]![1].title).toBe('Tienes 2 comunicados nuevos');
    const s = await h.app.status();
    expect(s.announcements.map((a) => a.title)).toEqual(['Primero', 'Segundo']);

    // Read again: nothing new to notify.
    h.chrome.world.notifications.clear();
    await h.app.refreshAnnouncements(0);
    expect([...h.chrome.world.notifications.keys()].filter((id) => id.startsWith('announcement:'))).toEqual([]);

    // A third one: its own notification, with its title.
    h.backend.announcements.set('n3', ann({ title: 'Tercero', createdAt: NOW }));
    await h.app.refreshAnnouncements(0);
    expect(h.chrome.world.notifications.get('announcement:n3')).toMatchObject({ title: 'Recursos Humanos: Tercero', requireInteraction: true });
  });

  it('confirming writes the read once and drops the card and the notification', async () => {
    h.backend.announcements.set('n1', ann());
    await h.app.refreshAnnouncements(0);
    expect(h.chrome.world.notifications.has('announcement:n1')).toBe(true);
    const res = await h.app.handlePopup({ type: 'announcements.ack', id: 'n1' });
    expect(res.ok && res.status.announcements).toEqual([]);
    expect(h.backend.ops('putAnnouncementRead')).toEqual([
      { op: 'putAnnouncementRead', docId: 'n1_u1', data: { announcementId: 'n1', uid: 'u1', readAt: NOW } },
    ]);
    expect(h.chrome.world.notifications.has('announcement:n1')).toBe(false);
    // Confirmed from another device: Firestore says it is read.
    h.backend.announcements.set('n2', ann({ createdAt: NOW }));
    h.backend.announcementReads.set('n2_u1', { announcementId: 'n2', uid: 'u1', readAt: NOW });
    await h.app.refreshAnnouncements(0);
    expect((await h.app.status()).announcements).toEqual([]);
  });

  it('a failed confirmation gives a Spanish message and keeps the card', async () => {
    h.backend.announcements.set('n1', ann());
    await h.app.refreshAnnouncements(0);
    h.backend.offline = true;
    const res = await h.app.handlePopup({ type: 'announcements.ack', id: 'n1' });
    expect(res).toMatchObject({ ok: false, reason: 'announcement-failed' });
    expect(res.status?.announcements.map((a) => a.id)).toEqual(['n1']);
  });

  it('offline or rules not deployed: the cache stays; signing out forgets it', async () => {
    h.backend.announcements.set('n1', ann());
    await h.app.refreshAnnouncements(0);
    h.backend.failures.push('permission-denied');
    await h.app.refreshAnnouncements(0);
    expect((await h.app.status()).announcements).toHaveLength(1);
    await h.app.signOut();
    expect(h.app.store.meta.announcements).toBeNull();
    expect(h.chrome.world.notifications.has('announcement:n1')).toBe(false);
  });

  it('the cache only refreshes when older than the given age', async () => {
    await h.app.refreshAnnouncements(60_000);
    await h.app.refreshAnnouncements(60_000);
    expect(h.backend.announcementFetches).toBe(1);
    vi.setSystemTime(NOW + 60_000);
    await h.app.refreshAnnouncements(60_000);
    expect(h.backend.announcementFetches).toBe(2);
  });

  it('merging keeps local confirmations and notified ids only for listed announcements of the same person', () => {
    const prev = mergeAnnouncements(null, 'u1', [{ ...ann(), id: 'a' }, { ...ann(), id: 'b' }], ['a'], 1);
    prev.notified = ['a', 'b'];
    const next = mergeAnnouncements(prev, 'u1', [{ ...ann(), id: 'b' }], [], 2);
    expect(next).toMatchObject({ readIds: [], notified: ['b'] });
    expect(mergeAnnouncements(prev, 'u2', [{ ...ann(), id: 'a' }], [], 2).notified).toEqual([]);
    expect(announcementCacheFromJSON(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(announcementCacheFromJSON({ uid: 1 })).toBeNull();
  });

  // Spec 2026-11-13-grupos-y-comunicados-agendados.
  it('only announcements for everyone or for this person arrive', async () => {
    h.backend.announcements.set('all', ann({ title: 'Para todos' }));
    h.backend.announcements.set('mine', ann({ title: 'Para terreno', audience: ['u1', 'u9'], groupIds: ['g1'] }));
    h.backend.announcements.set('other', ann({ title: 'Para jefaturas', audience: ['u9'], groupIds: ['g2'] }));
    await h.app.refreshAnnouncements(0);
    expect((await h.app.status()).announcements.map((a) => a.title).sort()).toEqual(['Para terreno', 'Para todos']);
  });

  it('a scheduled announcement is neither shown nor notified until its time, then once', async () => {
    h.backend.announcements.set('later', ann({ title: 'Mañana', createdAt: NOW - 60_000, publishAt: NOW + 10 * 60_000 }));
    await h.app.refreshAnnouncements(0);
    expect((await h.app.status()).announcements).toEqual([]);
    expect(h.chrome.world.notifications.has('announcement:later')).toBe(false);

    // Its time comes while the cache is still fresh: notified from the cache, without reading again.
    vi.setSystemTime(NOW + 10 * 60_000);
    const fetches = h.backend.announcementFetches;
    await h.app.refreshAnnouncements(60 * 60_000);
    expect(h.backend.announcementFetches).toBe(fetches);
    expect(h.chrome.world.notifications.get('announcement:later')).toMatchObject({ title: 'Recursos Humanos: Mañana' });
    const s = await h.app.status();
    expect(s.announcements.map((a) => [a.title, a.publishAt])).toEqual([['Mañana', NOW + 10 * 60_000]]);

    h.chrome.world.notifications.clear();
    await h.app.refreshAnnouncements(0);
    expect(h.chrome.world.notifications.has('announcement:later')).toBe(false);
  });

  it('a cache from before 0.2.29 (no publishAt) reads as sent at createdAt', () => {
    const c = announcementCacheFromJSON({
      uid: 'u1',
      fetchedAt: 1,
      items: [{ id: 'a', title: 't', body: 'b', authorName: 'RRHH', createdAt: 5 }],
      readIds: [],
      notified: [],
    });
    expect(c?.items[0]?.publishAt).toBe(5);
  });
});
