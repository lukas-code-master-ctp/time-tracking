import { describe, expect, it } from 'vitest';
import type { Celebration, WithId } from '@timetracking/shared';
import { buildCelebrationsDigest } from '../../src/core/celebrationsDigest.js';

const c = (id: string, over: Partial<Celebration>): WithId<Celebration> => ({
  id,
  displayName: id,
  birthday: null,
  hireDate: null,
  active: true,
  updatedAt: 0,
  updatedBy: 'admin',
  ...over,
});

// Monday 2026-11-09 to Sunday 2026-11-15.
const MONDAY = '2026-11-09';

describe('buildCelebrationsDigest', () => {
  it('lists the week, Monday to Sunday, with the boss', () => {
    const m = buildCelebrationsDigest({
      to: ['lukas@impulseai.cl'],
      monday: MONDAY,
      celebrations: [
        c('Ana', { birthday: '11-09', managerUid: 'boss' }),
        c('Beto', { hireDate: '2023-11-15' }),
        c('Carla', { birthday: '11-16' }),
        c('Dora', { birthday: '11-10', active: false }),
      ],
      managerName: (uid) => (uid === 'boss' ? 'Lukas' : null),
      portalUrl: 'https://portal.test',
    });
    expect(m).not.toBeNull();
    expect(m!.to).toEqual(['lukas@impulseai.cl']);
    expect(m!.subject).toBe('Cumpleaños y aniversarios de la semana (9 de noviembre al 15 de noviembre)');
    expect(m!.text).toContain('- Lunes 9 de noviembre: Ana, cumpleaños (jefatura: Lukas)');
    expect(m!.text).toContain('- Domingo 15 de noviembre: Beto, 3 años en la empresa');
    expect(m!.text).not.toContain('Carla');
    expect(m!.text).not.toContain('Dora');
    expect(m!.html).toContain('<a href="https://portal.test">');
  });

  it('is null for a week without celebrations', () => {
    expect(
      buildCelebrationsDigest({ to: ['a@b.cl'], monday: MONDAY, celebrations: [c('X', { birthday: '01-01' })], managerName: () => null, portalUrl: null }),
    ).toBeNull();
  });

  it('escapes names in the HTML', () => {
    const m = buildCelebrationsDigest({ to: ['a@b.cl'], monday: MONDAY, celebrations: [c('x', { displayName: '<b>Ana</b>', birthday: '11-09' })], managerName: () => null, portalUrl: null });
    expect(m!.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });
});
