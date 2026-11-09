/**
 * Light/dark choice of the extension pages (popup, consent, absences).
 * "system" follows Chrome/the OS (prefers-color-scheme); "light" and "dark"
 * force one through `<html data-theme>` (see base.css). Kept in localStorage,
 * which the extension pages share and which is read synchronously, so the
 * page is painted in the right theme from the first frame.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
export const THEME_LABEL: Record<Theme, string> = { system: 'Sistema', light: 'Claro', dark: 'Oscuro' };

const KEY = 'theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Storage blocked: the choice still applies to this page.
  }
  applyTheme(t);
}

/** Next theme of the popup's toggle: Sistema → Claro → Oscuro → Sistema. */
export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]!;
}

applyTheme(getTheme());
// Another open extension page changed it.
try {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) applyTheme(getTheme());
  });
} catch {
  // Not in a window (tests).
}
