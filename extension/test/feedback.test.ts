import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedDateTimeToMs } from '@timetracking/shared';
import { isPopupRequest } from '../src/messages';
import { ORG, createHarness, type Harness } from './fakes';

const T0 = zonedDateTimeToMs('2026-11-13', '12:00');

describe('anonymous feedback', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    h = await createHarness();
    h.backend.org = { ...ORG, feedbackEnabled: true };
    await h.app.refreshOrgConfig(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one comment a day without the uid in the comment', async () => {
    expect((await h.app.status()).feedback).toEqual({ sentToday: false });
    const res = await h.app.handlePopup({ type: 'feedback.send', tone: 'negative', text: '  Se cayó la VPN toda la mañana \n\n\n\n' });
    expect(res.ok).toBe(true);
    await h.settle();
    expect((await h.app.status()).feedback).toEqual({ sentToday: true });
    expect(h.backend.feedback).toEqual([{ week: '2026-W46', tone: 'negative', text: 'Se cayó la VPN toda la mañana' }]);
    expect(h.backend.feedbackVotes.get('u1_2026-W46')).toEqual(['2026-11-13']);

    // A second one the same day is refused before reaching the queue.
    const again = await h.app.handlePopup({ type: 'feedback.send', tone: 'positive', text: 'Otro' });
    expect(again).toMatchObject({ ok: false, reason: 'feedback-done' });
    await h.settle();
    expect(h.backend.feedback).toHaveLength(1);

    // Next day: allowed again, also without a work day open.
    vi.setSystemTime(zonedDateTimeToMs('2026-11-14', '10:00'));
    expect((await h.app.status()).feedback).toEqual({ sentToday: false });
    await h.app.handlePopup({ type: 'feedback.send', tone: 'positive', text: 'Buen cierre de semana' });
    await h.settle();
    expect(h.backend.feedback).toHaveLength(2);
  });

  it('rejects empty or long text, and does nothing when the organization has it off', async () => {
    expect(await h.app.handlePopup({ type: 'feedback.send', tone: 'positive', text: '   ' })).toMatchObject({
      ok: false,
      error: 'Escribe tu comentario.',
    });
    expect(await h.app.handlePopup({ type: 'feedback.send', tone: 'positive', text: 'x'.repeat(501) })).toMatchObject({
      ok: false,
      reason: 'feedback-invalid',
    });

    h.backend.org = { ...ORG };
    await h.app.refreshOrgConfig(0);
    expect((await h.app.status()).feedback).toBeNull();
    expect(await h.app.handlePopup({ type: 'feedback.send', tone: 'positive', text: 'Hola' })).toMatchObject({
      ok: false,
      reason: 'feedback-off',
    });
    await h.settle();
    expect(h.backend.calls.filter((c) => c.op === 'putFeedback')).toEqual([]);
  });

  it('validates the popup message', () => {
    expect(isPopupRequest({ type: 'feedback.send', tone: 'positive', text: 'Hola' })).toBe(true);
    expect(isPopupRequest({ type: 'feedback.send', tone: 'neutral', text: 'Hola' })).toBe(false);
    expect(isPopupRequest({ type: 'feedback.send', tone: 'positive' })).toBe(false);
  });
});
