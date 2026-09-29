/** Clock-aligned 10-minute blocks (09:00, 09:10, ...). */

export const SLOT_SECONDS = 600;
export const SLOT_MS = SLOT_SECONDS * 1000;

/**
 * Start of the block that contains `ms`. Blocks are aligned to the epoch,
 * which matches the wall clock (:00, :10, :20...) in every time zone whose
 * UTC offset is a multiple of 10 minutes — including Chile (UTC-3/-4).
 */
export function slotStartOf(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

/** End (exclusive) of the block that contains `ms`. */
export function slotEndOf(ms: number): number {
  return slotStartOf(ms) + SLOT_MS;
}

/**
 * Starts of every block that intersects the half-open interval [from, to).
 * Returns an empty array when `to <= from`.
 */
export function slotsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  if (!(to > from)) return out;
  for (let s = slotStartOf(from); s < to; s += SLOT_MS) out.push(s);
  return out;
}
