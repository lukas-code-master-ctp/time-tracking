import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_RANGE_DAYS,
  addDays,
  dayBounds,
  daysBetween,
  describeRange,
  formatRelativeDateTime,
  formatTime,
  isValidDate,
  presetRange,
  rangeIncludes,
  startOfDay,
  weekdayIndex,
  zonedDate,
} from '../src/lib/dates';

const H = 3_600_000;
// Tuesday 2026-09-29 15:30 in Santiago (UTC-3 in September after DST start).
const NOW = Date.UTC(2026, 8, 29, 18, 30);

describe('calendar helpers', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('weekday index starts on Monday', () => {
    expect(weekdayIndex('2026-09-28')).toBe(0); // Monday
    expect(weekdayIndex('2026-09-29')).toBe(1);
    expect(weekdayIndex('2026-10-04')).toBe(6); // Sunday
  });

  it('validates dates', () => {
    expect(isValidDate('2026-09-29')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('29-09-2026')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });
});

describe('startOfDay in America/Santiago', () => {
  it('normal day (UTC-3): midnight is 03:00Z', () => {
    expect(startOfDay('2026-09-29')).toBe(Date.UTC(2026, 8, 29, 3));
    expect(zonedDate(startOfDay('2026-09-29'))).toBe('2026-09-29');
    expect(zonedDate(startOfDay('2026-09-29') - 1)).toBe('2026-09-28');
  });

  it('winter day (UTC-4): midnight is 04:00Z', () => {
    expect(startOfDay('2026-07-15')).toBe(Date.UTC(2026, 6, 15, 4));
  });

  it('DST start day has no 00:00: the day starts at 01:00 and lasts 23 h', () => {
    const { from, to } = dayBounds('2026-09-06');
    expect(from).toBe(Date.UTC(2026, 8, 6, 4));
    expect(formatTime(from)).toBe('01:00');
    expect(to - from).toBe(23 * H);
  });

  it('DST end day repeats 23:00: the previous day lasts 25 h', () => {
    const { from, to } = dayBounds('2026-04-04');
    expect(from).toBe(Date.UTC(2026, 3, 4, 3));
    expect(to).toBe(Date.UTC(2026, 3, 5, 4));
    expect(to - from).toBe(25 * H);
  });

  it('works in other zones', () => {
    expect(startOfDay('2026-09-29', 'UTC')).toBe(Date.UTC(2026, 8, 29));
    expect(startOfDay('2026-09-29', 'Asia/Kathmandu')).toBe(Date.UTC(2026, 8, 28, 18, 15));
  });
});

describe('presetRange', () => {
  it('today and yesterday', () => {
    const today = presetRange('today', NOW);
    expect(today).toMatchObject({ preset: 'today', fromDate: '2026-09-29', toDate: '2026-09-29' });
    expect(today.from).toBe(Date.UTC(2026, 8, 29, 3));
    expect(today.to).toBe(Date.UTC(2026, 8, 30, 3));
    expect(rangeIncludes(today, NOW)).toBe(true);
    const y = presetRange('yesterday', NOW);
    expect(y).toMatchObject({ fromDate: '2026-09-28', toDate: '2026-09-28' });
    expect(rangeIncludes(y, NOW)).toBe(false);
  });

  it('"today" follows the Santiago calendar, not UTC', () => {
    // 2026-09-30 01:00Z is still 2026-09-29 22:00 in Santiago.
    expect(presetRange('today', Date.UTC(2026, 8, 30, 1)).fromDate).toBe('2026-09-29');
  });

  it('this week runs Monday to Sunday', () => {
    expect(presetRange('thisWeek', NOW)).toMatchObject({ fromDate: '2026-09-28', toDate: '2026-10-04' });
    // On a Sunday the week started six days before.
    expect(presetRange('thisWeek', Date.UTC(2026, 9, 4, 15))).toMatchObject({ fromDate: '2026-09-28', toDate: '2026-10-04' });
  });

  it('last 7 days includes today', () => {
    const r = presetRange('last7', NOW);
    expect(r).toMatchObject({ fromDate: '2026-09-23', toDate: '2026-09-29' });
  });

  it('this month covers every day of the month', () => {
    expect(presetRange('thisMonth', NOW)).toMatchObject({ fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(presetRange('thisMonth', Date.UTC(2028, 1, 10, 15))).toMatchObject({ fromDate: '2028-02-01', toDate: '2028-02-29' });
    const dec = presetRange('thisMonth', Date.UTC(2026, 11, 20, 15));
    expect(dec).toMatchObject({ fromDate: '2026-12-01', toDate: '2026-12-31' });
    expect(dec.to).toBe(startOfDay('2027-01-01'));
  });

  it('custom range is inclusive, ordered and falls back to today', () => {
    const r = presetRange('custom', NOW, undefined, { fromDate: '2026-09-10', toDate: '2026-09-01' });
    expect(r).toMatchObject({ preset: 'custom', fromDate: '2026-09-01', toDate: '2026-09-10' });
    expect(r.to).toBe(startOfDay('2026-09-11'));
    expect(presetRange('custom', NOW, undefined, { fromDate: 'x', toDate: '' })).toMatchObject({
      fromDate: '2026-09-29',
      toDate: '2026-09-29',
    });
  });

  it(`custom range is capped at ${MAX_CUSTOM_RANGE_DAYS} days, keeping the end`, () => {
    expect(daysBetween('2026-09-01', '2026-09-30')).toBe(29);
    expect(daysBetween('2026-09-30', '2026-09-01')).toBe(-29);
    const exact = presetRange('custom', NOW, undefined, { fromDate: '2026-06-29', toDate: '2026-09-29' });
    expect(daysBetween(exact.fromDate, exact.toDate) + 1).toBe(93);
    expect(exact.clamped).toBeUndefined();
    const long = presetRange('custom', NOW, undefined, { fromDate: '2025-01-01', toDate: '2026-09-29' });
    expect(long).toMatchObject({ fromDate: '2026-06-29', toDate: '2026-09-29', clamped: true });
    expect(long.from).toBe(startOfDay('2026-06-29'));
    // Reversed input is ordered before capping (the later date stays).
    expect(presetRange('custom', NOW, undefined, { fromDate: '2026-09-29', toDate: '2020-01-01' })).toMatchObject({
      fromDate: '2026-06-29',
      toDate: '2026-09-29',
      clamped: true,
    });
  });
});

describe('formatting', () => {
  it('describes ranges day-first', () => {
    expect(describeRange(presetRange('today', NOW))).toBe('29-09-2026');
    expect(describeRange(presetRange('last7', NOW))).toBe('23-09-2026 – 29-09-2026');
  });

  it('relative date-time', () => {
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 29, 17, 5), NOW)).toBe('hoy 14:05');
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 28, 21, 10), NOW)).toBe('ayer 18:10');
    expect(formatRelativeDateTime(Date.UTC(2026, 8, 20, 12, 0), NOW)).toBe('20-09-2026 09:00');
  });
});
