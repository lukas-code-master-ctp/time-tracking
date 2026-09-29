/** Shared configuration and constants. */

import { normalizeDomain, parseEmailList } from './domain.js';
import type { OrgConfig } from './types.js';

export type AppEnv = 'dev' | 'prod';

export const DEFAULT_ALLOWED_DOMAIN = 'compratuparcela.cl';
export const FIREBASE_DEMO_PROJECT_ID = 'demo-timetracking';
export const FUNCTIONS_REGION = 'southamerica-west1';

export const EMULATOR_PORTS = {
  auth: 9099,
  firestore: 8080,
  storage: 9199,
  functions: 5001,
  hosting: 5000,
  ui: 4000,
} as const;

/** Version of the transparency notice the collaborator accepts (spec section 4). */
export const CONSENT_VERSION = '2026-09-29';

/** chrome.idle detection threshold in seconds. */
export const IDLE_DETECTION_SECONDS = 15;
/** Heartbeat alarm period (chrome.alarms minimum is 30 s). */
export const ALARM_PERIOD_MS = 30_000;
/** How often the current block and the session heartbeat are uploaded. */
export const SYNC_INTERVAL_MS = 60_000;
/** Longest interval without measurement events that is still counted (see accumulator). */
export const MAX_TICK_GAP_MS = 90_000;
/** Max URLs kept per block. */
export const MAX_URLS_PER_SLOT = 20;
/** A session without heartbeat for longer than this is closed automatically. */
export const STALE_SESSION_MS = 30 * 60_000;
/** A session open for longer than this is closed automatically. */
export const MAX_SESSION_MS = 16 * 60 * 60_000;

export const SCREENSHOT_MAX_WIDTH = 1280;
export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const SCREENSHOT_JPEG_QUALITY = 0.7;
export const MAX_PENDING_SCREENSHOTS = 20;
export const DEFAULT_SCREENSHOT_RETENTION_DAYS = 90;

export interface AppConfig {
  allowedDomain: string;
  /** Lowercase emails that become admin on first login without invitation. */
  bootstrapAdmins: string[];
  appEnv: AppEnv;
}

export type EnvLike = Record<string, string | boolean | undefined>;

function pick(env: EnvLike, name: string): string | undefined {
  const v = env[name] ?? env[`VITE_${name}`];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Builds the app config from an env-like object. Works with `process.env`
 * (functions) and `import.meta.env` (Vite, where names carry a `VITE_` prefix).
 * Unknown `APP_ENV` values fall back to `prod` (the safe choice: no dev login).
 */
export function resolveConfig(env: EnvLike = {}): AppConfig {
  const appEnvRaw = pick(env, 'APP_ENV')?.toLowerCase();
  return {
    allowedDomain: normalizeDomain(pick(env, 'ALLOWED_DOMAIN') ?? DEFAULT_ALLOWED_DOMAIN),
    bootstrapAdmins: parseEmailList(pick(env, 'BOOTSTRAP_ADMINS')),
    appEnv: appEnvRaw === 'dev' ? 'dev' : 'prod',
  };
}

/** Default `config/org` created on bootstrap. */
export function defaultOrgConfig(
  now: number,
  allowedDomain: string = DEFAULT_ALLOWED_DOMAIN,
  updatedBy = 'system',
): OrgConfig {
  return {
    allowedDomain: normalizeDomain(allowedDomain),
    screenshotsEnabled: false,
    blurScreenshots: true,
    screenshotRetentionDays: DEFAULT_SCREENSHOT_RETENTION_DAYS,
    updatedAt: now,
    updatedBy,
  };
}
