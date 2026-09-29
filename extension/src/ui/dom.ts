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

/** `3 h 05 min` / `12 min` */
export function hoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function percent(active: number, tracked: number): string {
  return tracked > 0 ? `${Math.round((active / tracked) * 100)} %` : '—';
}
