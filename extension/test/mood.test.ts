import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedDateTimeToMs } from '@timetracking/shared';
import { isPopupRequest } from '../src/messages';
import { ORG, createHarness, type Harness } from './fakes';

const T0 = zonedDateTimeToMs('2026-11-05', '18:30');

describe('mood pulse', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    h = await createHarness();
    h.backend.org = { ...ORG, moodPulseEnabled: true };
    await h.app.refreshOrgConfig(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks once after closing the work day by hand and uploads the anonymous counter', async () => {
    await h.app.session.start();
    expect((await h.app.status()).mood).toEqual({ pending: false });
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).mood).toEqual({ pending: true });
    await h.app.handlePopup({ type: 'mood.answer', score: 4 });
    await h.settle();
    expect((await h.app.status()).mood).toEqual({ pending: false });
    expect(h.backend.moodWeeks.get('2026-W45')).toEqual({ n4: 1 });
    expect(h.backend.moodVotes.get('u1_2026-W45')).toEqual(['2026-11-05']);
    // Closing again the same day does not ask again.
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).mood).toEqual({ pending: false });
  });

  it('"Omitir" sends nothing; a pending question expires with the day', async () => {
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    await h.app.handlePopup({ type: 'mood.answer', score: null });
    await h.settle();
    expect(h.backend.calls.filter((c) => c.op === 'putMood')).toEqual([]);

    vi.setSystemTime(zonedDateTimeToMs('2026-11-06', '18:30'));
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).mood).toEqual({ pending: true });
    vi.setSystemTime(zonedDateTimeToMs('2026-11-07', '09:00'));
    expect((await h.app.status()).mood).toEqual({ pending: false });
    await h.app.handlePopup({ type: 'mood.answer', score: 2 });
    await h.settle();
    expect(h.backend.calls.filter((c) => c.op === 'putMood')).toEqual([]);
  });

  it('is off when the organization has it off', async () => {
    h.backend.org = { ...ORG };
    await h.app.refreshOrgConfig(0);
    await h.app.session.start();
    await h.app.handlePopup({ type: 'session.stop' });
    expect((await h.app.status()).mood).toBeNull();
  });

  it('validates the popup message', () => {
    expect(isPopupRequest({ type: 'mood.answer', score: 5 })).toBe(true);
    expect(isPopupRequest({ type: 'mood.answer', score: null })).toBe(true);
    expect(isPopupRequest({ type: 'mood.answer', score: 6 })).toBe(false);
    expect(isPopupRequest({ type: 'mood.answer' })).toBe(false);
  });
});
