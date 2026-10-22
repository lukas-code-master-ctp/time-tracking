import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOT_MS, slotStartOf } from '@timetracking/shared';
import { isPopupRequest, type AbsenceRequest } from '../src/messages';
import { PROFILE, createHarness, type Harness } from './fakes';

// Spec 2026-10-22-solicitud-ausencias: the person requests absences from the extension.
const NOW = slotStartOf(1_790_000_000_000) + SLOT_MS;

const vacation: AbsenceRequest = { type: 'vacation', startDate: '2026-10-26', endDate: '2026-10-30', startTime: null, endTime: null, note: ' Viaje ' };

describe('absence requests (spec 2026-10-22-solicitud-ausencias)', () => {
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
    expect(isPopupRequest({ type: 'absences.list' })).toBe(true);
    expect(isPopupRequest({ type: 'absences.request', absence: vacation })).toBe(true);
    expect(isPopupRequest({ type: 'absences.request' })).toBe(false);
    expect(isPopupRequest({ type: 'absences.cancel', id: 'x' })).toBe(true);
    expect(isPopupRequest({ type: 'absences.cancel' })).toBe(false);
  });

  it('a request is written pending, by and for the person, and listed newest first', async () => {
    const res = await h.app.handlePopup({ type: 'absences.request', absence: vacation });
    expect(res.ok).toBe(true);
    expect(h.backend.ops('createAbsence')).toEqual([
      {
        op: 'createAbsence',
        id: 'abs-1',
        data: {
          uid: 'u1',
          type: 'vacation',
          startDate: '2026-10-26',
          endDate: '2026-10-30',
          startTime: null,
          endTime: null,
          note: 'Viaje',
          status: 'pending',
          createdAt: NOW,
          createdBy: 'u1',
          updatedAt: NOW,
          updatedBy: 'u1',
        },
      },
    ]);
    // An approved one from the admin, and someone else's (not listed).
    h.backend.absences.set('adm', { ...h.backend.absences.get('abs-1')!, startDate: '2026-11-02', endDate: '2026-11-02', status: 'approved', createdBy: 'admin' });
    h.backend.absences.set('other', { ...h.backend.absences.get('abs-1')!, uid: 'u2' });
    const list = await h.app.handlePopup({ type: 'absences.list' });
    expect(list.ok && list.absences!.map((a) => a.id)).toEqual(['adm', 'abs-1']);
  });

  it('hours are a single day; invalid requests get a Spanish message', async () => {
    await h.app.handlePopup({
      type: 'absences.request',
      absence: { type: 'errand', startDate: '2026-10-26', endDate: '2026-10-28', startTime: '09:00', endTime: '11:00', note: '' },
    });
    expect(h.backend.ops('createAbsence')[0]).toMatchObject({ data: { startDate: '2026-10-26', endDate: '2026-10-26', startTime: '09:00' } });

    const bad = await h.app.handlePopup({ type: 'absences.request', absence: { ...vacation, type: 'other', note: '' } });
    expect(bad).toMatchObject({ ok: false, reason: 'absence-invalid' });
    const reversed = await h.app.handlePopup({ type: 'absences.request', absence: { ...vacation, endDate: '2026-10-01' } });
    expect(reversed).toMatchObject({ ok: false, reason: 'absence-invalid' });
    expect(h.backend.ops('createAbsence')).toHaveLength(1);
  });

  it('only a pending request can be withdrawn', async () => {
    await h.app.handlePopup({ type: 'absences.request', absence: vacation });
    const res = await h.app.handlePopup({ type: 'absences.cancel', id: 'abs-1' });
    expect(res.ok && res.absences).toEqual([]);
    h.backend.absences.set('adm', { ...vacation, uid: 'u1', status: 'approved', createdAt: 1, createdBy: 'admin', updatedAt: 1, updatedBy: 'admin' });
    const refused = await h.app.handlePopup({ type: 'absences.cancel', id: 'adm' });
    expect(refused).toMatchObject({ ok: false, reason: 'absences-failed' });
    expect(refused.ok || refused.error).toMatch(/ya no puedes cambiar/);
  });

  it('needs a signed-in member who accepted the notice; offline is reported', async () => {
    h.backend.offline = true;
    const off = await h.app.handlePopup({ type: 'absences.list' });
    expect(off).toMatchObject({ ok: false, reason: 'absences-failed' });
    expect(off.ok || off.error).toMatch(/Revisa tu conexión/);
    h.backend.offline = false;

    h.app.store.meta.profile = { ...PROFILE, consentVersion: 'vieja' };
    expect(await h.app.handlePopup({ type: 'absences.list' })).toMatchObject({ ok: false, reason: 'consent-required' });
    h.auth.user = null;
    expect(await h.app.handlePopup({ type: 'absences.request', absence: vacation })).toMatchObject({ ok: false, reason: 'signed-out' });
  });
});
