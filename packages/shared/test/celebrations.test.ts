import { describe, expect, it } from 'vitest';
import {
  dayMonthLabel,
  isValidBirthday,
  readCelebration,
  upcomingCelebrations,
  validateCelebration,
  yearsLabel,
  type Celebration,
} from '../src/index.js';

const c = (id: string, over: Partial<Celebration>): Celebration & { id: string } => ({
  id,
  displayName: id,
  birthday: null,
  hireDate: null,
  active: true,
  updatedAt: 0,
  updatedBy: 'admin',
  ...over,
});

describe('isValidBirthday', () => {
  it('accepts real days including Feb 29', () => {
    expect(isValidBirthday('01-31')).toBe(true);
    expect(isValidBirthday('02-29')).toBe(true);
    expect(isValidBirthday('02-30')).toBe(false);
    expect(isValidBirthday('04-31')).toBe(false);
    expect(isValidBirthday('13-01')).toBe(false);
    expect(isValidBirthday('2026-01-01')).toBe(false);
  });
});

describe('validateCelebration', () => {
  it('rejects a future or invalid hire date', () => {
    expect(validateCelebration({ birthday: null, hireDate: null }, '2026-11-05')).toEqual([]);
    expect(validateCelebration({ birthday: '02-29', hireDate: '2020-03-01' }, '2026-11-05')).toEqual([]);
    expect(validateCelebration({ birthday: null, hireDate: '2026-11-06' }, '2026-11-05')[0]?.path).toBe('hireDate');
    expect(validateCelebration({ birthday: '02-31', hireDate: null }, '2026-11-05')[0]?.path).toBe('birthday');
  });
});

describe('readCelebration', () => {
  it('reads valid docs and drops broken ones', () => {
    expect(readCelebration({ displayName: 'Ana', birthday: '03-14', hireDate: null, active: true })?.birthday).toBe('03-14');
    expect(readCelebration({ displayName: 'Ana', birthday: '3-14' })).toBeNull();
    expect(readCelebration(null)).toBeNull();
  });
});

describe('upcomingCelebrations', () => {
  const today = '2026-11-05';
  it('lists today and the next days, soonest first', () => {
    const list = upcomingCelebrations(
      [
        c('Ana', { birthday: '11-05' }),
        c('Bruno', { hireDate: '2023-11-08' }),
        c('Carla', { birthday: '11-20' }),
        c('Diego', { birthday: '11-06', active: false }),
      ],
      today,
      7,
    );
    expect(list.map((x) => [x.uid, x.kind, x.daysAway, x.years])).toEqual([
      ['Ana', 'birthday', 0, null],
      ['Bruno', 'anniversary', 3, 3],
    ]);
  });

  it('skips the first year and wraps around the new year', () => {
    expect(upcomingCelebrations([c('Eva', { hireDate: '2026-11-05' })], today, 7)).toEqual([]);
    const list = upcomingCelebrations([c('Fede', { birthday: '01-02' })], '2026-12-30', 7);
    expect(list[0]).toMatchObject({ date: '2027-01-02', daysAway: 3 });
  });

  it('celebrates Feb 29 on Feb 28 outside leap years', () => {
    expect(upcomingCelebrations([c('Gabi', { birthday: '02-29' })], '2027-02-28', 0)[0]?.date).toBe('2027-02-28');
    expect(upcomingCelebrations([c('Gabi', { birthday: '02-29' })], '2028-02-28', 0)).toEqual([]);
  });
});

describe('labels', () => {
  it('formats', () => {
    expect(yearsLabel(1)).toBe('1 año');
    expect(yearsLabel(4)).toBe('4 años');
    expect(dayMonthLabel('03-14')).toBe('14 de marzo');
    expect(dayMonthLabel('2026-12-01')).toBe('1 de diciembre');
  });
});
