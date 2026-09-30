import { describe, expect, it } from 'vitest';
import type { ScreenshotMeta, WithId } from '@timetracking/shared';
import { dayBounds } from '../src/lib/dates';
import { activityLevel, buildTimeline } from '../src/lib/timeline';
import { slot } from './fakes';

const M = 60_000;
const day = dayBounds('2026-09-29'); // starts 2026-09-29T03:00Z (00:00 local)
const at = (h: number, m = 0): number => day.from + h * 60 * M + m * M;

function shot(takenAt: number, id = `s${takenAt}`): WithId<ScreenshotMeta> {
  return { id, uid: 'u1', sessionId: 's', takenAt, storagePath: `screenshots/u1/2026-09-29/${id}.jpg`, blurred: true, width: 1280, height: 720 };
}

describe('activityLevel', () => {
  it('uses the shared thresholds', () => {
    expect(activityLevel(null)).toBe('none');
    expect(activityLevel(0)).toBe('low');
    expect(activityLevel(39)).toBe('low');
    expect(activityLevel(40)).toBe('mid');
    expect(activityLevel(69)).toBe('mid');
    expect(activityLevel(70)).toBe('high');
    expect(activityLevel(100)).toBe('high');
  });
});

describe('buildTimeline', () => {
  it('lays blocks in hour rows between the first and last hour with data', () => {
    const slots = [
      slot('u1', at(9, 10), 600, 540, { domains: { 'a.cl': 300, 'b.cl': 200, 'c.cl': 60, 'd.cl': 40 }, outsideChromeSeconds: 120 }),
      slot('u1', at(9, 20), 300, 60),
      slot('u1', at(11, 50), 600, 300),
    ];
    const t = buildTimeline(day.from, day.to, slots, [shot(at(9, 14))]);
    expect(t.rows.map((r) => r.hourLabel)).toEqual(['09:00', '10:00', '11:00']);
    expect(t.rows.every((r) => r.blocks.length === 6)).toBe(true);
    expect(t.blocksWithData).toBe(3);

    const [b900, b910, b920] = t.rows[0]!.blocks;
    expect(b900).toMatchObject({ label: '09:00', percent: null, level: 'none', trackedSeconds: 0 });
    expect(b910).toMatchObject({
      label: '09:10',
      rangeLabel: '09:10–09:20',
      percent: 90,
      level: 'high',
      outsideChromeSeconds: 120,
    });
    expect(b910!.topDomains.map((d) => d.domain)).toEqual(['a.cl', 'b.cl', 'c.cl']);
    expect(b910!.screenshots).toHaveLength(1);
    expect(b920).toMatchObject({ percent: 20, level: 'low' });
    expect(t.rows[2]!.blocks[5]).toMatchObject({ label: '11:50', percent: 50, level: 'mid' });
  });

  it('ignores data outside the day and clamps inconsistent values', () => {
    const t = buildTimeline(day.from, day.to, [
      slot('u1', day.from - 600_000),
      slot('u1', day.to),
      slot('u1', at(8), 600, 900, { outsideChromeSeconds: 1000 }),
    ]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.blocks[0]).toMatchObject({ activeSeconds: 600, outsideChromeSeconds: 600, percent: 100 });
  });

  it('meeting time is left out of the % and marks the block', () => {
    const t = buildTimeline(day.from, day.to, [
      // 5 min meeting of 10: 60 active of the 300 outside the meeting → 20 %, mostly meeting.
      slot('u1', at(9), 600, 60, { meetingSeconds: 300 }),
      // Short meeting: marker only, colored by its level (270 / 480 → 56 %).
      slot('u1', at(9, 10), 600, 270, { meetingSeconds: 120 }),
      // The whole block in a meeting: no % ("—").
      slot('u1', at(9, 20), 600, 0, { meetingSeconds: 600 }),
      // Extension 0.1.1 (no field): read as 0.
      slot('u1', at(9, 30), 600, 300),
      // Inconsistent (active + meeting > tracked): meeting clamped to 600 - 500.
      slot('u1', at(9, 40), 600, 500, { meetingSeconds: 400 }),
    ]);
    const [b0, b10, b20, b30, b40] = t.rows[0]!.blocks;
    expect(b0).toMatchObject({ meetingSeconds: 300, mostlyMeeting: true, percent: 20, level: 'low' });
    expect(b10).toMatchObject({ meetingSeconds: 120, mostlyMeeting: false, percent: 56, level: 'mid' });
    expect(b20).toMatchObject({ meetingSeconds: 600, mostlyMeeting: true, percent: null, level: 'none', trackedSeconds: 600 });
    expect(b30).toMatchObject({ meetingSeconds: 0, mostlyMeeting: false, percent: 50 });
    expect(b40).toMatchObject({ meetingSeconds: 100, mostlyMeeting: false, percent: 100 });
    expect(t.blocksWithData).toBe(5);
  });

  it('shows hours with only a screenshot', () => {
    const t = buildTimeline(day.from, day.to, [], [shot(at(13, 5))]);
    expect(t.rows.map((r) => r.hourLabel)).toEqual(['13:00']);
    expect(t.blocksWithData).toBe(0);
  });

  it('empty day → no rows (compact) or 24 rows (full)', () => {
    expect(buildTimeline(day.from, day.to, []).rows).toEqual([]);
    const full = buildTimeline(day.from, day.to, [], [], { span: 'full' });
    expect(full.rows).toHaveLength(24);
    expect(full.rows[0]!.hourLabel).toBe('00:00');
    expect(full.rows[23]!.hourLabel).toBe('23:00');
  });

  it('DST start day: 23 rows starting at 01:00', () => {
    const d = dayBounds('2026-09-06');
    const full = buildTimeline(d.from, d.to, [], [], { span: 'full' });
    expect(full.rows).toHaveLength(23);
    expect(full.rows[0]!.hourLabel).toBe('01:00');
  });

  it('DST end day: the repeated 23:00 hour gets its own row', () => {
    const d = dayBounds('2026-04-04');
    const full = buildTimeline(d.from, d.to, [], [], { span: 'full' });
    expect(full.rows).toHaveLength(25);
    expect(full.rows.slice(-2).map((r) => r.hourLabel)).toEqual(['23:00', '23:00']);
    expect(full.rows.every((r) => r.blocks.length === 6)).toBe(true);
  });
});
