/** Runtime view of the build configuration. */
import { DEFAULT_ALLOWED_DOMAINS, MAX_ALLOWED_DOMAINS, parseDomainList, type AppEnv } from '@timetracking/shared';

export const APP_ENV: AppEnv = __APP_ENV__;
export const IS_DEV = __APP_ENV__ === 'dev';

export const BUILD_CONFIG = __BUILD_CONFIG__;

/**
 * Allowed Workspace domains shown in messages (`VITE_ALLOWED_DOMAIN`, comma
 * separated; defaults from shared). The server (`joinOrg`) is the authority.
 */
const parsedDomains = parseDomainList(BUILD_CONFIG.allowedDomains).slice(0, MAX_ALLOWED_DOMAINS);
export const ALLOWED_DOMAINS: readonly string[] = parsedDomains.length > 0 ? parsedDomains : DEFAULT_ALLOWED_DOMAINS;
