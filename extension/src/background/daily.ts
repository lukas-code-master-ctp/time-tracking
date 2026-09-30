/**
 * Today's hours and activity for the popup, computed only from local data
 * (no Firestore reads).
 *
 * Every snapshot of a 10-minute block that the accumulator produces (closed
 * blocks and the partial "current" one, every pulse and when the work day is
 * closed) is recorded here by `slotStart`. Snapshots of a block are
 * cumulative, so the newest one replaces the previous one. Only the blocks of
 * the current calendar day (America/Santiago, like the portal) of one user are
 * kept: the summary resets when the day or the user changes.
 */
import { DEFAULT_TIME_ZONE, dateKey, type ActivitySlot } from '@timetracking/shared';

export interface DailySummary {
  uid: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** slotStart → seconds of that block (`meeting` missing in older summaries = 0). */
  slots: Record<string, { tracked: number; active: number; meeting?: number }>;
}

export interface TodayTotals {
  trackedSeconds: number;
  activeSeconds: number;
  /** In a web meeting without keyboard/mouse (never overlaps activeSeconds). */
  meetingSeconds: number;
}

const clampInt = (n: unknown, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;

/** Records snapshots; returns the (possibly new) summary. Pure. */
export function recordSlots(
  summary: DailySummary | null,
  slots: readonly ActivitySlot[],
  timeZone: string = DEFAULT_TIME_ZONE,
): DailySummary | null {
  let out = summary;
  for (const slot of slots) {
    const date = dateKey(slot.slotStart, timeZone);
    if (!out || out.uid !== slot.uid || out.date < date) {
      out = { uid: slot.uid, date, slots: {} };
    } else if (out.date > date) {
      continue; // snapshot of a previous day (late upload): not today
    }
    const tracked = clampInt(slot.trackedSeconds, 600);
    const active = Math.min(clampInt(slot.activeSeconds, 600), tracked);
    const meeting = Math.min(clampInt(slot.meetingSeconds, 600), tracked - active);
    out.slots[String(slot.slotStart)] = { tracked, active, meeting };
  }
  return out;
}

/** Totals of `uid` for the day of `now`. */
export function todayTotals(
  summary: DailySummary | null,
  uid: string | null,
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): TodayTotals {
  if (!summary || !uid || summary.uid !== uid || summary.date !== dateKey(now, timeZone)) {
    return { trackedSeconds: 0, activeSeconds: 0, meetingSeconds: 0 };
  }
  let trackedSeconds = 0;
  let activeSeconds = 0;
  let meetingSeconds = 0;
  for (const s of Object.values(summary.slots)) {
    trackedSeconds += s.tracked;
    activeSeconds += s.active;
    meetingSeconds += s.meeting ?? 0;
  }
  return { trackedSeconds, activeSeconds, meetingSeconds };
}

export function dailyFromJSON(raw: unknown): DailySummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DailySummary>;
  if (typeof r.uid !== 'string' || typeof r.date !== 'string' || !r.slots || typeof r.slots !== 'object') return null;
  const slots: DailySummary['slots'] = {};
  for (const [k, v] of Object.entries(r.slots)) {
    if (!/^\d+$/.test(k) || !v || typeof v !== 'object') continue;
    const tracked = clampInt((v as { tracked?: unknown }).tracked, 600);
    const active = Math.min(clampInt((v as { active?: unknown }).active, 600), tracked);
    const meeting = Math.min(clampInt((v as { meeting?: unknown }).meeting, 600), tracked - active);
    slots[k] = { tracked, active, meeting };
  }
  return { uid: r.uid, date: r.date, slots };
}
