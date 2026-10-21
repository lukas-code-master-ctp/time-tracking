import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BREAK_EXERCISES,
  breakDocId,
  exerciseAt,
  exerciseById,
  readActiveBreakSettings,
} from '../src/index.js';

describe('active breaks', () => {
  it('reads the settings of config/org: off and defaults when missing or invalid', () => {
    expect(readActiveBreakSettings(null)).toEqual({ enabled: false, intervalMinutes: 60, durationMinutes: 5 });
    expect(readActiveBreakSettings({ activeBreaksEnabled: true, activeBreakIntervalMinutes: 90, activeBreakMinutes: 3 })).toEqual({
      enabled: true,
      intervalMinutes: 90,
      durationMinutes: 3,
    });
    expect(readActiveBreakSettings({ activeBreaksEnabled: 'true', activeBreakIntervalMinutes: 5, activeBreakMinutes: 2.5 })).toEqual({
      enabled: false,
      intervalMinutes: 60,
      durationMinutes: 5,
    });
  });

  it('rotates the exercises; unique ids that fit the rules (≤ 40 chars)', () => {
    const ids = ACTIVE_BREAK_EXERCISES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length <= 40)).toBe(true);
    expect(exerciseAt(0)).toBe(ACTIVE_BREAK_EXERCISES[0]);
    expect(exerciseAt(ACTIVE_BREAK_EXERCISES.length + 1)).toBe(ACTIVE_BREAK_EXERCISES[1]);
    expect(exerciseById('vista')?.title).toBe('Descansa la vista (20-20-20)');
    expect(exerciseById('nope')).toBeNull();
  });

  it('breakDocId is uid_promptedAt', () => {
    expect(breakDocId('u1', 1_790_000_000_000)).toBe('u1_1790000000000');
    expect(() => breakDocId('', 1)).toThrow();
    expect(() => breakDocId('u1', 1.5)).toThrow();
  });
});
