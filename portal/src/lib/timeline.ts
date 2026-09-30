/**
 * Day timeline of one collaborator: 10-minute blocks laid out in hour rows.
 * Pure: receives the day bounds, the activity docs and the screenshots.
 */
import {
  DEFAULT_TIME_ZONE,
  SLOT_MS,
  activityPercent,
  meetingSecondsOf,
  slotsBetween,
  type ActivitySlot,
  type DayPlan,
  type ScreenshotMeta,
  type WithId,
} from '@timetracking/shared';
import { formatTime, zonedParts } from './dates';

export type ActivityLevel = 'none' | 'low' | 'mid' | 'high';

/** Thresholds shared by the timeline, the team table bars and the legend. */
export const ACTIVITY_LEVELS: readonly { level: Exclude<ActivityLevel, 'none'>; label: string; min: number }[] = [
  { level: 'low', label: 'Baja (menos de 40 %)', min: 0 },
  { level: 'mid', label: 'Media (40 a 69 %)', min: 40 },
  { level: 'high', label: 'Alta (70 % o más)', min: 70 },
];

/**
 * A block is "mostly in a meeting" when its meeting time is at least half of
 * the measured time: it gets the meeting color instead of its activity level.
 */
export const MEETING_BLOCK_SHARE = 0.5;

export function activityLevel(percent: number | null): ActivityLevel {
  if (percent === null) return 'none';
  if (percent >= 70) return 'high';
  if (percent >= 40) return 'mid';
  return 'low';
}

export interface TimelineBlock {
  slotStart: number;
  /** "09:10" */
  label: string;
  /** "09:10–09:20" */
  rangeLabel: string;
  trackedSeconds: number;
  activeSeconds: number;
  outsideChromeSeconds: number;
  /** Seconds in a web meeting without keyboard/mouse (0 for 0.1.1 docs). */
  meetingSeconds: number;
  /** meetingSeconds >= 50 % of trackedSeconds: painted with the meeting color. */
  mostlyMeeting: boolean;
  /**
   * active / (tracked - meeting). null = no data in this block, or the whole
   * block was a meeting (shown as "—").
   */
  percent: number | null;
  level: ActivityLevel;
  topDomains: { domain: string; seconds: number }[];
  screenshots: WithId<ScreenshotMeta>[];
  /**
   * Where the block falls in the day's schedule (the state covering most of
   * its 10 minutes; ties favor 'work', then 'lunch'). null = no schedule.
   */
  schedule: BlockScheduleState | null;
  /** Scheduled entry / exit inside this block. */
  marks: ScheduleMark[];
}

export type BlockScheduleState = 'work' | 'lunch' | 'off';

export interface ScheduleMark {
  kind: 'start' | 'end';
  /** Position inside the block, 0 (its start) … 1 (its end). */
  at: number;
  /** "09:00" */
  time: string;
}

export interface TimelineRow {
  /** "09:00" — wall-clock hour of the row. */
  hourLabel: string;
  blocks: TimelineBlock[];
}

export interface Timeline {
  rows: TimelineRow[];
  /** Blocks with measured time. */
  blocksWithData: number;
}

export interface TimelineOptions {
  timeZone?: string;
  /** Top domains per block (default 3). */
  topDomains?: number;
  /**
   * `compact` (default) shows only the hours between the first and the last
   * block with data (or screenshot); `full` shows the whole day.
   */
  span?: 'compact' | 'full';
  /**
   * The person's schedule for the day (`planForDay`): each block gets its
   * state and the entry/exit marks, and the compact view always includes
   * the scheduled hours. null/undefined = no schedule.
   */
  plan?: DayPlan | null;
}

function overlap(a: number, b: number, from: number, to: number): number {
  return Math.max(0, Math.min(b, to) - Math.max(a, from));
}

/** State covering most of `[start, start + SLOT_MS)`. */
export function blockScheduleState(start: number, plan: DayPlan): BlockScheduleState {
  const end = start + SLOT_MS;
  const work = plan.work.reduce((t, w) => t + overlap(start, end, w.start, w.end), 0);
  const lunch = plan.lunch ? overlap(start, end, plan.lunch.start, plan.lunch.end) : 0;
  const off = SLOT_MS - work - lunch;
  if (work >= lunch && work >= off) return 'work';
  return lunch >= off ? 'lunch' : 'off';
}

/**
 * Builds the timeline of the day `[from, to)`. Blocks are grouped by their
 * wall-clock hour, so a DST day simply has one row more or less.
 */
export function buildTimeline(
  from: number,
  to: number,
  slots: readonly ActivitySlot[],
  screenshots: readonly WithId<ScreenshotMeta>[] = [],
  options: TimelineOptions = {},
): Timeline {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const topN = options.topDomains ?? 3;
  const plan = options.plan ?? null;

  const bySlot = new Map<number, ActivitySlot>();
  for (const s of slots) {
    if (s.slotStart < from || s.slotStart >= to) continue;
    // Duplicates should not exist (deterministic ids); keep the most complete.
    const prev = bySlot.get(s.slotStart);
    if (!prev || s.trackedSeconds > prev.trackedSeconds) bySlot.set(s.slotStart, s);
  }
  const shotsBySlot = new Map<number, WithId<ScreenshotMeta>[]>();
  for (const shot of screenshots) {
    if (shot.takenAt < from || shot.takenAt >= to) continue;
    const key = Math.floor(shot.takenAt / SLOT_MS) * SLOT_MS;
    const list = shotsBySlot.get(key) ?? [];
    list.push(shot);
    shotsBySlot.set(key, list);
  }

  const blocks: TimelineBlock[] = slotsBetween(from, to).map((slotStart) => {
    const slot = bySlot.get(slotStart);
    const tracked = Math.max(0, slot?.trackedSeconds ?? 0);
    const active = Math.min(Math.max(0, slot?.activeSeconds ?? 0), tracked);
    const meeting = slot ? meetingSecondsOf({ trackedSeconds: tracked, activeSeconds: active, meetingSeconds: slot.meetingSeconds }) : 0;
    // Meeting time neither raises nor lowers the percentage.
    const percent = activityPercent(active, tracked, meeting);
    return {
      slotStart,
      label: formatTime(slotStart, timeZone),
      rangeLabel: `${formatTime(slotStart, timeZone)}–${formatTime(slotStart + SLOT_MS, timeZone)}`,
      trackedSeconds: tracked,
      activeSeconds: active,
      outsideChromeSeconds: Math.min(Math.max(0, slot?.outsideChromeSeconds ?? 0), tracked),
      meetingSeconds: meeting,
      mostlyMeeting: tracked > 0 && meeting >= tracked * MEETING_BLOCK_SHARE,
      percent,
      level: activityLevel(percent),
      topDomains: Object.entries(slot?.domains ?? {})
        .map(([domain, seconds]) => ({ domain, seconds }))
        .sort((a, b) => b.seconds - a.seconds || a.domain.localeCompare(b.domain))
        .slice(0, topN),
      screenshots: (shotsBySlot.get(slotStart) ?? []).sort((a, b) => a.takenAt - b.takenAt),
      schedule: plan ? blockScheduleState(slotStart, plan) : null,
      marks: plan?.span ? marksIn(slotStart, plan.span, timeZone) : [],
    };
  });

  // Group consecutive blocks by wall-clock hour.
  const rows: TimelineRow[] = [];
  let current: TimelineRow | null = null;
  let currentKey = '';
  for (const block of blocks) {
    const p = zonedParts(block.slotStart, timeZone);
    const key = `${p.date} ${p.hour}`;
    // An hour has 6 blocks; on the fall-back day the repeated hour gets its own row.
    if (!current || key !== currentKey || current.blocks.length >= 6) {
      current = { hourLabel: `${String(p.hour).padStart(2, '0')}:00`, blocks: [] };
      currentKey = key;
      rows.push(current);
    }
    current.blocks.push(block);
  }

  // Content = data, a screenshot, or the scheduled hours (entry → exit).
  const hasContent = (r: TimelineRow): boolean =>
    r.blocks.some((b) => b.trackedSeconds > 0 || b.screenshots.length > 0 || b.marks.length > 0 || (b.schedule !== null && b.schedule !== 'off'));
  let visible = rows;
  if ((options.span ?? 'compact') === 'compact') {
    const first = rows.findIndex(hasContent);
    if (first === -1) {
      visible = [];
    } else {
      let last = rows.length - 1;
      while (last > first && !hasContent(rows[last]!)) last--;
      visible = rows.slice(first, last + 1);
    }
  }
  return { rows: visible, blocksWithData: blocks.filter((b) => b.trackedSeconds > 0).length };
}

/** Entry (at `span.start`) and exit (at the end of the block holding `span.end - 1 ms`) marks of a block. */
function marksIn(slotStart: number, span: { start: number; end: number }, timeZone: string): ScheduleMark[] {
  const out: ScheduleMark[] = [];
  const end = slotStart + SLOT_MS;
  if (span.start >= slotStart && span.start < end) {
    out.push({ kind: 'start', at: (span.start - slotStart) / SLOT_MS, time: formatTime(span.start, timeZone) });
  }
  if (span.end > slotStart && span.end <= end) {
    out.push({ kind: 'end', at: (span.end - slotStart) / SLOT_MS, time: formatTime(span.end, timeZone) });
  }
  return out;
}
