/**
 * "Pausa activa" in the portal: when the reminders of the `daily` mode come
 * (spec 2026-10-22-pausa-activa-veces-al-dia), computed like the extension
 * does from each person's schedule.
 */
import { dailyBreakTargets, planForDay, type ActiveBreakSettings } from '@timetracking/shared';
import { formatTime } from './dates';
import type { ActiveBreaksForm } from './payloads';
import type { EffectiveSchedule } from './schedule';

/** Length of the day the extension assumes without a schedule (extension/src/background/schedule.ts). */
export const NO_SCHEDULE_BREAK_DAY_MS = 9 * 3_600_000;

export function settingsOfForm(form: ActiveBreaksForm): ActiveBreakSettings {
  return {
    enabled: form.activeBreaksEnabled,
    mode: form.activeBreakMode,
    intervalMinutes: form.activeBreakIntervalMinutes,
    perDay: form.activeBreaksPerDay,
    durationMinutes: form.activeBreakMinutes,
  };
}

/**
 * Instants of the reminders of `date` for one person: the working time of
 * their schedule that day (lunch excluded) split in equal parts; without a
 * schedule, 9 hours from `dayStartedAt` (the first work day of the date;
 * none yet: `[]`). null when the reminders are off or not in `daily` mode.
 */
export function plannedBreaks(
  settings: ActiveBreakSettings,
  schedule: EffectiveSchedule,
  date: string,
  dayStartedAt: number | null,
): number[] | null {
  if (!settings.enabled || settings.mode !== 'daily') return null;
  if (schedule.week) return dailyBreakTargets(planForDay(date, schedule.week, schedule.holidays).work, settings.perDay);
  if (dayStartedAt === null) return [];
  return dailyBreakTargets([{ start: dayStartedAt, end: dayStartedAt + NO_SCHEDULE_BREAK_DAY_MS }], settings.perDay);
}

/** "11:00", "11:00 y 16:00", "11:00, 14:00 y 16:00". */
export function joinTimes(times: readonly number[]): string {
  const labels = times.map((t) => formatTime(t));
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}
