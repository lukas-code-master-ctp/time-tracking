/** Build configuration (Vite `import.meta.env`, see `.env.development` / `.env.production`). */
import { DEFAULT_ALLOWED_DOMAINS, MAX_ALLOWED_DOMAINS, parseDomainList } from '@timetracking/shared';

/**
 * `vite --mode development`: emulators + dev login. Dev-only branches test
 * `import.meta.env.DEV` directly (Vite replaces it with a literal and the
 * minifier drops the dead code); this export is for display logic only.
 */
export const IS_DEV: boolean = import.meta.env.DEV;

function clean(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export const FIREBASE_CONFIG = {
  apiKey: clean(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: clean(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: clean(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: clean(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  appId: clean(import.meta.env.VITE_FIREBASE_APP_ID),
  messagingSenderId: clean(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
};

/**
 * Workspace domains (`VITE_ALLOWED_DOMAIN`, comma separated; defaults from
 * shared). Used for the login hint and as fallback until `config/org` is
 * read. The server (`joinOrg`) is the authority.
 */
export function allowedDomainsFromEnv(raw: string | undefined): readonly string[] {
  const list = parseDomainList(clean(raw)).slice(0, MAX_ALLOWED_DOMAINS);
  return list.length > 0 ? list : DEFAULT_ALLOWED_DOMAINS;
}

export const ALLOWED_DOMAINS: readonly string[] = allowedDomainsFromEnv(import.meta.env.VITE_ALLOWED_DOMAIN);

/**
 * Custom parameters of the Google login popup. `hd` restricts the account
 * chooser to one Workspace domain, so it is only sent when there is exactly
 * one; with several domains (different organizations) the chooser stays open.
 * Either way it is only a hint: `joinOrg` enforces the domains.
 */
export function googleLoginParams(domains: readonly string[]): Record<string, string> {
  const only = domains.length === 1 ? domains[0] : undefined;
  return only ? { hd: only, prompt: 'select_account' } : { prompt: 'select_account' };
}

/** Chrome Web Store link copied from the Invitations page. */
export const EXTENSION_INSTALL_URL = clean(import.meta.env.VITE_EXTENSION_INSTALL_URL);

/** Fake link of `.env.development` / `functions/.env.demo-timetracking`. */
export const DEV_INSTALL_URL = 'https://chromewebstore.google.com/detail/dev-extension';

/**
 * True when the install link is not a real one: empty, a `REEMPLAZAR_…`
 * placeholder, not an https URL, or the fake dev link.
 */
export function isPlaceholderInstallUrl(url: string): boolean {
  const v = url.trim();
  if (!v || v.toUpperCase().includes('REEMPLAZAR') || v.replace(/\/+$/, '') === DEV_INSTALL_URL) return true;
  try {
    return new URL(v).protocol !== 'https:';
  } catch {
    return true;
  }
}

/** True while `.env.production` still has `REEMPLAZAR_…` placeholders. */
export const HAS_PLACEHOLDERS = Object.values(FIREBASE_CONFIG).some((v) => v.startsWith('REEMPLAZAR'));
