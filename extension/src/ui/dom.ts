/** Tiny DOM helpers shared by the popup and the consent page (no framework). */
import type { PopupRequest, PopupResponse } from '../messages';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  children: (Node | string | null | false)[] = [],
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const c of children) if (c !== null && c !== false) node.append(c);
  return node;
}

export async function send(req: PopupRequest): Promise<PopupResponse> {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as PopupResponse | undefined;
    return res ?? { ok: false, error: 'Sin respuesta de la extensión.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `h:mm:ss` */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Time of the work day clock: `now - startedAt` minus the part of `pauses`
 * (lunches, when the organization pauses the clock) already elapsed.
 */
export function workDayElapsed(startedAt: number, now: number, pauses: readonly { start: number; end: number }[] = []): number {
  let ms = now - startedAt;
  for (const p of pauses) ms -= Math.max(0, Math.min(p.end, now) - Math.max(p.start, startedAt));
  return Math.max(0, ms);
}

/** `3 h 05 min` / `12 min` */
export function hoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/** Activity %: meeting time is left out of the denominator ("—" when nothing else was measured). */
export function percent(active: number, tracked: number, meeting = 0): string {
  const base = tracked - Math.max(0, meeting);
  return base > 0 ? `${Math.min(100, Math.round((Math.max(0, active) / base) * 100))} %` : '—';
}
