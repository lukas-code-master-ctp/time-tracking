/** Shared configuration and constants. */

import { MAX_ALLOWED_DOMAINS, normalizeDomainList, parseDomainList, parseEmailList } from './domain.js';
import type { OrgConfig } from './types.js';

export type AppEnv = 'dev' | 'prod';

/** Workspace domains allowed by default (two separate Google Workspace organizations). */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = Object.freeze(['impulseai.cl', 'compratuparcela.cl']);
export const FIREBASE_DEMO_PROJECT_ID = 'demo-timetracking';
export const FUNCTIONS_REGION = 'southamerica-west1';
/**
 * Cloud Scheduler is not available in southamerica-west1, so scheduled jobs run in the
 * closest region that has it (São Paulo). They only use the Admin SDK, so the region
 * doesn't need to match Firestore's.
 */
export const SCHEDULER_REGION = 'southamerica-east1';

export const EMULATOR_PORTS = {
  auth: 9099,
  firestore: 8080,
  storage: 9199,
  functions: 5001,
  hosting: 5000,
  ui: 4000,
} as const;

/**
 * Version of the transparency notice the collaborator accepts (spec section 4).
 * 2026-09-30: adds web meeting detection ("En reunión"); everyone accepts again once.
 * 2026-09-30.2: working hours (extension 0.2.0): nothing is measured outside
 * the schedule nor in the lunch, and start/end reminders.
 */
export const CONSENT_VERSION = '2026-09-30.2';

/** First notice version that describes web meeting detection (tracker.ts). */
export const MEETING_CONSENT_VERSION = '2026-09-30';

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
/**
 * No pulse for longer than this with the work day open means the computer
 * slept (lid closed, e.g. at lunch) or Chrome was closed: the extension
 * treats the gap as a pause (see extension session.ts).
 */
export const SUSPEND_GAP_MS = 5 * 60_000;
/** Longest such pause after which the work day continues on its own (same day only). */
export const MAX_RESUME_GAP_MS = 4 * 60 * 60_000;

export const SCREENSHOT_MAX_WIDTH = 1280;
export const SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const SCREENSHOT_JPEG_QUALITY = 0.7;
export const MAX_PENDING_SCREENSHOTS = 20;
export const DEFAULT_SCREENSHOT_RETENTION_DAYS = 90;

export interface AppConfig {
  /** Normalized, unique, 1–10 domains (`ALLOWED_DOMAIN`, comma separated). */
  allowedDomains: string[];
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
    allowedDomains: domainsOrDefault(parseDomainList(pick(env, 'ALLOWED_DOMAIN'))),
    bootstrapAdmins: parseEmailList(pick(env, 'BOOTSTRAP_ADMINS')),
    appEnv: appEnvRaw === 'dev' ? 'dev' : 'prod',
  };
}

/** Normalized list capped at `MAX_ALLOWED_DOMAINS`, or the defaults when empty. */
function domainsOrDefault(domains: readonly unknown[]): string[] {
  const list = normalizeDomainList(domains).slice(0, MAX_ALLOWED_DOMAINS);
  return list.length > 0 ? list : [...DEFAULT_ALLOWED_DOMAINS];
}

/**
 * Allowed domains stored in a `config/org` document (normalized, max 10).
 * Tolerates old documents with a single `allowedDomain` string (read as
 * `[allowedDomain]`). Returns `[]` when the document has none, so callers
 * apply their own fallback (env / defaults).
 */
export function readAllowedDomains(config: unknown): string[] {
  if (!config || typeof config !== 'object') return [];
  const c = config as { allowedDomains?: unknown; allowedDomain?: unknown };
  if (Array.isArray(c.allowedDomains)) {
    const list = normalizeDomainList(c.allowedDomains).slice(0, MAX_ALLOWED_DOMAINS);
    if (list.length > 0) return list;
  }
  if (typeof c.allowedDomain === 'string') return normalizeDomainList([c.allowedDomain]);
  return [];
}

/** `readAllowedDomains(config)`, or `fallback` (normalized) when the config has none. */
export function allowedDomainsOr(config: unknown, fallback: readonly string[]): string[] {
  const list = readAllowedDomains(config);
  return list.length > 0 ? list : domainsOrDefault(fallback);
}

/** Default `config/org` created on bootstrap. */
export function defaultOrgConfig(
  now: number,
  allowedDomains: readonly string[] = DEFAULT_ALLOWED_DOMAINS,
  updatedBy = 'system',
): OrgConfig {
  return {
    allowedDomains: domainsOrDefault(allowedDomains),
    screenshotsEnabled: false,
    blurScreenshots: true,
    screenshotRetentionDays: DEFAULT_SCREENSHOT_RETENTION_DAYS,
    updatedAt: now,
    updatedBy,
  };
}
