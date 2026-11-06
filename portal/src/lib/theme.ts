/** Light / dark theme: follows the system unless the admin picks one (per browser). */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'tt-portal-theme';

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
}

export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system';
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Tema: sistema',
  light: 'Tema: claro',
  dark: 'Tema: oscuro',
};

/**
 * Forces the light theme while the sign-in screens are shown (they are always
 * light, like the landing) and returns the function that puts back the
 * admin's choice. Does not touch the stored choice.
 */
export function forceLightTheme(): () => void {
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'light');
  return () => {
    if (previous === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previous);
  };
}
