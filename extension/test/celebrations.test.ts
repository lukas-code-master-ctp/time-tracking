import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Celebration } from '@timetracking/shared';
import { CELEBRATIONS_REFRESH_MS } from '../src/background/app';
import { createHarness, type Harness } from './fakes';

// Thursday 2026-11-05 12:00 in Santiago.
const NOW = Date.UTC(2026, 10, 5, 15, 0);

const c = (displayName: string, over: Partial<Celebration> = {}): Celebration => ({
  displayName,
  birthday: null,
  hireDate: null,
  active: true,
  updatedAt: 0,
  updatedBy: 'admin',
  ...over,
});

describe('team birthdays and anniversaries (spec 2026-11-05-cumpleanos-aniversarios)', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h = await createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows today and the next 7 days in the status, and marks your own', async () => {
    h.backend.celebrations.set('u1', c('Yo', { birthday: '11-05' }));
    h.backend.celebrations.set('ana', c('Ana', { hireDate: '2023-11-09' }));
    h.backend.celebrations.set('bea', c('Bea', { birthday: '11-20' }));
    h.backend.celebrations.set('dora', c('Dora', { birthday: '11-06', active: false }));
    await h.app.refreshCelebrations(0);
    const status = await h.app.status();
    expect(status.celebrations.map((x) => [x.name, x.kind, x.daysAway, x.years, x.self])).toEqual([
      ['Yo', 'birthday', 0, null, true],
      ['Ana', 'anniversary', 4, 3, false],
    ]);
  });

  it('re-reads them at most every few hours and keeps the cache when offline', async () => {
    h.backend.celebrations.set('ana', c('Ana', { birthday: '11-05' }));
    await h.app.refreshCelebrations(0);
    const fetches = h.backend.celebrationFetches;
    await h.app.refreshConfig(60_000);
    await h.app.refreshConfig(5 * 60_000);
    expect(h.backend.celebrationFetches).toBe(fetches);
    vi.setSystemTime(NOW + CELEBRATIONS_REFRESH_MS);
    h.backend.offline = true;
    await h.app.refreshConfig(60_000);
    vi.setSystemTime(NOW);
    expect((await h.app.status()).celebrations).toHaveLength(1);
  });

  it('forgets them on sign-out', async () => {
    h.backend.celebrations.set('ana', c('Ana', { birthday: '11-05' }));
    await h.app.refreshCelebrations(0);
    await h.app.signOut();
    expect((await h.app.status()).celebrations).toEqual([]);
  });
});
