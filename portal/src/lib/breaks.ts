/**
 * "Pausa activa" in the portal: when the reminders of the `daily` mode come
 * (spec 2026-10-22-pausa-activa-veces-al-dia), computed like the extension
 * does from each person's schedule.
 */
import { breakTargets, normalizeBreakTimes, planForDay, type ActiveBreakSettings } from '@timetracking/shared';
import { formatTime } from './dates';
import type { ActiveBreaksForm, BreakVideosForm } from './payloads';
import type { EffectiveSchedule } from './schedule';

/** Length of the day the extension assumes without a schedule (extension/src/background/schedule.ts). */
export const NO_SCHEDULE_BREAK_DAY_MS = 9 * 3_600_000;

export function settingsOfForm(form: ActiveBreaksForm, videos?: BreakVideosForm): ActiveBreakSettings {
  return {
    enabled: form.activeBreaksEnabled,
    mode: form.activeBreakMode,
    intervalMinutes: form.activeBreakIntervalMinutes,
    perDay: form.activeBreaksPerDay,
    times: normalizeBreakTimes(form.activeBreakTimes.filter((t) => t !== '')) ?? [],
    durationMinutes: form.activeBreakMinutes,
    videos: videos?.videos ?? [],
    videoMode: videos?.mode ?? 'alternate',
  };
}

/** A reminder of the plan of the day: its instant and its place in the plan (picks the exercise). */
export interface PlannedBreak {
  at: number;
  index: number;
}

/**
 * The reminders of `date` for one person, like the extension computes them.
 * `daily`: the working time of their schedule that day (lunch excluded)
 * split in equal parts; without a schedule, 9 hours from `dayStartedAt` (the
 * first work day of the date; none yet: `[]`). `times`: the chosen times
 * that fall inside their schedule (the extension does not remind out of it
 * nor at lunch); without a schedule, all of them. null when the reminders
 * are off or in `interval` mode.
 */
export function plannedBreakSlots(
  settings: ActiveBreakSettings,
  schedule: EffectiveSchedule,
  date: string,
  dayStartedAt: number | null,
): PlannedBreak[] | null {
  if (!settings.enabled || settings.mode === 'interval') return null;
  const work = schedule.week
    ? planForDay(date, schedule.week, schedule.holidays).work
    : dayStartedAt === null
      ? []
      : [{ start: dayStartedAt, end: dayStartedAt + NO_SCHEDULE_BREAK_DAY_MS }];
  const all = breakTargets(settings, work, date);
  if (settings.mode !== 'times' || !schedule.week) return all;
  return all.filter((t) => work.some((w) => t.at >= w.start && t.at < w.end));
}

/** The instants of {@link plannedBreakSlots}. */
export function plannedBreaks(
  settings: ActiveBreakSettings,
  schedule: EffectiveSchedule,
  date: string,
  dayStartedAt: number | null,
): number[] | null {
  return plannedBreakSlots(settings, schedule, date, dayStartedAt)?.map((t) => t.at) ?? null;
}

/** "11:00", "11:00 y 16:00", "11:00, 14:00 y 16:00". */
export function joinTimes(times: readonly number[]): string {
  const labels = times.map((t) => formatTime(t));
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}
