import { describe, expect, it } from 'vitest';
import {
  MOOD_OPTIONS,
  isoWeekKey,
  isValidWeekKey,
  lastWeeks,
  mergeMood,
  moodOfAverage,
  moodVoteDocId,
  readMoodPulseEnabled,
  summarizeMood,
  weekMonday,
} from '../src/index.js';

describe('mood pulse', () => {
  it('computes ISO weeks, also across the new year', () => {
    expect(isoWeekKey('2026-11-05')).toBe('2026-W45');
    expect(isoWeekKey('2026-11-02')).toBe('2026-W45');
    expect(isoWeekKey('2026-11-08')).toBe('2026-W45');
    expect(isoWeekKey('2026-11-09')).toBe('2026-W46');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
    expect(() => isoWeekKey('2026-02-30')).toThrow();
  });

  it('finds the Monday of a week and the last weeks', () => {
    expect(weekMonday('2026-W45')).toBe('2026-11-02');
    expect(weekMonday('2026-W01')).toBe('2025-12-29');
    expect(weekMonday('2026-W53')).toBe('2026-12-28');
    expect(lastWeeks('2026-11-05', 3)).toEqual(['2026-W43', '2026-W44', '2026-W45']);
    expect(lastWeeks('2026-01-02', 2)).toEqual(['2025-W52', '2026-W01']);
    expect(isValidWeekKey('2026-W45')).toBe(true);
    expect(isValidWeekKey('2026-W54')).toBe(false);
    expect(isValidWeekKey('2026-45')).toBe(false);
  });

  it('summarizes the counters and hides weeks with few answers', () => {
    expect(summarizeMood(null)).toEqual({ counts: [0, 0, 0, 0, 0], total: 0, average: null, hidden: true });
    expect(summarizeMood({ n4: 2 })).toMatchObject({ total: 2, average: 4, hidden: true });
    const s = summarizeMood({ n1: 1, n3: 1, n5: 2, n2: -1, x: 9 });
    expect(s).toEqual({ counts: [1, 0, 1, 0, 2], total: 4, average: 3.5, hidden: false });
    expect(mergeMood([summarizeMood({ n4: 2 }), summarizeMood({ n2: 2 })])).toMatchObject({ total: 4, average: 3, hidden: false });
    expect(moodOfAverage(3.5).score).toBe(4);
    expect(moodOfAverage(1.2).score).toBe(1);
    expect(MOOD_OPTIONS.map((o) => o.score)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads the setting and builds the vote id', () => {
    expect(readMoodPulseEnabled(null)).toBe(false);
    expect(readMoodPulseEnabled({ moodPulseEnabled: 'yes' })).toBe(false);
    expect(readMoodPulseEnabled({ moodPulseEnabled: true })).toBe(true);
    expect(moodVoteDocId('alice', '2026-W45')).toBe('alice_2026-W45');
    expect(() => moodVoteDocId('alice', '2026-45')).toThrow();
  });
});
