import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedDateTimeToMs } from '@timetracking/shared';
import { isPopupRequest } from '../src/messages';
import { ORG, createHarness, type Harness } from './fakes';

const T0 = zonedDateTimeToMs('2026-11-13', '18:30');

describe('daily report (minuta diaria)', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    h = await createHarness();
    h.backend.org = { ...ORG, dailyReportEnabled: true, dailyReportGroupIds: ['terreno'] };
    h.backend.groupsOf.set('u1', ['terreno', 'otro']);
    await h.app.refreshOrgConfig(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the members of the groups after closing the work day, until sent', async () => {
    expect((await h.app.status()).dailyReport).toEqual({ pending: false, sentToday: false });
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).dailyReport).toEqual({ pending: true, sentToday: false });

    const res = await h.app.handlePopup({ type: 'dailyReport.send', text: '  - Visité Maipú.  ', source: 'text', transcript: 'ignored' });
    expect(res.ok).toBe(true);
    const saved = h.backend.dailyReports.get('u1_2026-11-13');
    expect(saved).toMatchObject({ uid: 'u1', date: '2026-11-13', text: '- Visité Maipú.', source: 'text', transcript: null });
    expect((await h.app.status()).dailyReport).toEqual({ pending: false, sentToday: true });

    // A correction keeps createdAt.
    vi.advanceTimersByTime(60_000);
    await h.app.handlePopup({ type: 'dailyReport.send', text: '- Visité Maipú y Pudahuel.', source: 'audio', transcript: 'Hoy fui…' });
    const fixed = h.backend.dailyReports.get('u1_2026-11-13')!;
    expect(fixed.createdAt).toBe(saved!.createdAt);
    expect(fixed.updatedAt).toBeGreaterThan(saved!.updatedAt);
    expect(fixed.transcript).toBe('Hoy fui…');

    // Not asked again today.
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).dailyReport).toEqual({ pending: false, sentToday: true });
  });

  it('"Ahora no" stops the reminder for today; it comes back the next day', async () => {
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    await h.app.handlePopup({ type: 'dailyReport.skip' });
    expect((await h.app.status()).dailyReport).toEqual({ pending: false, sentToday: false });

    vi.setSystemTime(zonedDateTimeToMs('2026-11-14', '18:30'));
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).dailyReport).toEqual({ pending: true, sentToday: false });
  });

  it('returns the AI draft of an audio', async () => {
    const res = await h.app.handlePopup({ type: 'dailyReport.draft', audio: 'UklGRg==', mimeType: 'audio/wav' });
    expect(res.ok && res.draft).toEqual(h.backend.draft);
  });

  it('rejects an empty report', async () => {
    const res = await h.app.handlePopup({ type: 'dailyReport.send', text: '   ', source: 'text', transcript: null });
    expect(res.ok).toBe(false);
    expect(h.backend.dailyReports.size).toBe(0);
  });

  it('is not asked of people outside the groups, nor when the organization has it off', async () => {
    h.backend.groupsOf.set('u1', ['otro']);
    await h.app.refreshOrgConfig(0);
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).dailyReport).toBeNull();
    const res = await h.app.handlePopup({ type: 'dailyReport.get' });
    expect(res.ok).toBe(false);

    h.backend.groupsOf.set('u1', ['terreno']);
    h.backend.org = { ...ORG, dailyReportGroupIds: ['terreno'] };
    await h.app.refreshOrgConfig(0);
    expect((await h.app.status()).dailyReport).toBeNull();
  });

  it('validates the popup messages', () => {
    expect(isPopupRequest({ type: 'dailyReport.get' })).toBe(true);
    expect(isPopupRequest({ type: 'dailyReport.skip' })).toBe(true);
    expect(isPopupRequest({ type: 'dailyReport.draft', audio: 'x', mimeType: 'audio/wav' })).toBe(true);
    expect(isPopupRequest({ type: 'dailyReport.draft', audio: 1, mimeType: 'audio/wav' })).toBe(false);
    expect(isPopupRequest({ type: 'dailyReport.send', text: 'a', source: 'text', transcript: null })).toBe(true);
    expect(isPopupRequest({ type: 'dailyReport.send', text: 'a', source: 'voz', transcript: null })).toBe(false);
  });
});
