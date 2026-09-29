/** Runtime view of the build configuration. */
import { DEFAULT_ALLOWED_DOMAIN, normalizeDomain, type AppEnv } from '@timetracking/shared';

export const APP_ENV: AppEnv = __APP_ENV__;
export const IS_DEV = __APP_ENV__ === 'dev';

export const BUILD_CONFIG = __BUILD_CONFIG__;

export const ALLOWED_DOMAIN = normalizeDomain(BUILD_CONFIG.allowedDomain || DEFAULT_ALLOWED_DOMAIN);
