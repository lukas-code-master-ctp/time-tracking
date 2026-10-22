import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BREAK_EXERCISES,
  breakDocId,
  dailyBreakTargets,
  breakClosing,
  dailyExercise,
  exerciseInstructions,
  exerciseAt,
  exerciseById,
  readActiveBreakSettings,
} from '../src/index.js';

describe('active breaks', () => {
  it('reads the settings of config/org: off and defaults when missing or invalid', () => {
    const defaults = { enabled: false, mode: 'interval', intervalMinutes: 60, perDay: 3, durationMinutes: 5 };
    expect(readActiveBreakSettings(null)).toEqual(defaults);
    expect(readActiveBreakSettings({ activeBreaksEnabled: true, activeBreakIntervalMinutes: 90, activeBreakMinutes: 3 })).toEqual({
      ...defaults,
      enabled: true,
      intervalMinutes: 90,
      durationMinutes: 3,
    });
    expect(
      readActiveBreakSettings({ activeBreaksEnabled: true, activeBreakMode: 'daily', activeBreaksPerDay: 4, activeBreakMinutes: 10 }),
    ).toEqual({ ...defaults, enabled: true, mode: 'daily', perDay: 4, durationMinutes: 10 });
    expect(
      readActiveBreakSettings({
        activeBreaksEnabled: 'true',
        activeBreakMode: 'weekly',
        activeBreakIntervalMinutes: 5,
        activeBreaksPerDay: 13,
        activeBreakMinutes: 2.5,
      }),
    ).toEqual(defaults);
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

  it('daily targets split the working time of the day in perDay + 1 parts (lunch excluded)', () => {
    const h = (n: number) => n * 3_600_000;
    // 9–13 and 14–18: 8 h of work.
    const work = [
      { start: h(9), end: h(13) },
      { start: h(14), end: h(18) },
    ];
    expect(dailyBreakTargets(work, 3)).toEqual([h(11), h(14), h(16)]);
    expect(dailyBreakTargets(work, 1)).toEqual([h(14)]);
    expect(dailyBreakTargets([{ start: h(9), end: h(18) }], 2)).toEqual([h(12), h(15)]);
    expect(dailyBreakTargets([], 3)).toEqual([]);
    expect(dailyBreakTargets(work, 0)).toEqual([]);
  });

  it('daily plan: the exercise depends only on the date and the reminder, and moves on every day', () => {
    const ids = (date: string) => [0, 1, 2].map((i) => dailyExercise(date, i, 3).id);
    expect(new Set(ids('2026-10-22')).size).toBe(3);
    // The next day starts where the previous one ended.
    expect(dailyExercise('2026-10-23', 0, 3)).toBe(exerciseAt(ACTIVE_BREAK_EXERCISES.indexOf(dailyExercise('2026-10-22', 2, 3)) + 1));
  });

  it('instructions: the exercise plus what to do with the rest of the break', () => {
    const ex = ACTIVE_BREAK_EXERCISES[0]!;
    expect(exerciseInstructions(ex, 1)).toBe(ex.text);
    expect(exerciseInstructions(ex, 3)).toBe(`${ex.text} Si te sobra tiempo, repítelo una vez más.`);
    expect(exerciseInstructions(ex, 5)).toBe(`${ex.text} ${breakClosing(5)}`);
    expect(breakClosing(5)).toMatch(/^Repítelo 2 veces/);
    expect(breakClosing(10)).toMatch(/^Repítelo 2 o 3 veces/);
  });

  it('breakDocId is uid_promptedAt', () => {
    expect(breakDocId('u1', 1_790_000_000_000)).toBe('u1_1790000000000');
    expect(() => breakDocId('', 1)).toThrow();
    expect(() => breakDocId('u1', 1.5)).toThrow();
  });
});
