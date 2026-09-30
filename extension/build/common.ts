/**
 * Shared pieces of the three Vite builds (background, content, popup).
 * See `scripts/build.ts` for the orchestration.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, type InlineConfig } from 'vite';
import type { AppEnv } from './manifest.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHARED_ENTRY = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

/** Web config of the Firebase project (not secret: it ships in every client). */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  appId: string;
  messagingSenderId: string;
}

/** Everything the runtime needs from the build (injected as `__BUILD_CONFIG__`). */
export interface BuildConfig {
  appEnv: AppEnv;
  firebase: FirebaseWebConfig;
  /** Host of the Firebase emulators (dev only). */
  emulatorHost: string;
  /** Raw `VITE_ALLOWED_DOMAIN`: comma separated list (parsed at runtime; empty = defaults). */
  allowedDomains: string;
  oauthClientId: string;
}

/**
 * Build flavours:
 * - `dev`: emulators, dev login/debug hooks, fixed dev `key` → `dist-dev/`.
 * - `prod`: the package uploaded to Chrome Web Store → `dist/` (never `key`).
 * - `qa`: exactly the prod bundle (same Vite mode `production`, same
 *   `.env.production` + `.env.production.local`) plus the store item's `key`
 *   in the manifest → `dist-qa/`, to load unpacked with the store ID.
 */
export type BuildTarget = 'dev' | 'prod' | 'qa';

/** Vite mode (and `.env.<mode>` files) of each target: QA reuses production. */
export function viteModeOf(target: BuildTarget): 'development' | 'production' {
  return target === 'dev' ? 'development' : 'production';
}

export function appEnvOf(target: BuildTarget): AppEnv {
  return target === 'dev' ? 'dev' : 'prod';
}

export function outDirOf(target: BuildTarget): string {
  return { dev: 'dist-dev', prod: 'dist', qa: 'dist-qa' }[target];
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

/** Reads `.env`, `.env.<mode>` and `.env.<mode>.local` (only `VITE_*`). */
export function resolveBuildConfig(target: BuildTarget): BuildConfig {
  const env = loadEnv(viteModeOf(target), ROOT, 'VITE_');
  const get = (name: string, fallback = ''): string => (env[`VITE_${name}`] ?? fallback).trim();
  const appEnv = appEnvOf(target);
  // Dev always talks to the demo project of the emulators.
  const dev = appEnv === 'dev';
  return {
    appEnv,
    firebase: {
      apiKey: get('FIREBASE_API_KEY', dev ? 'demo-api-key' : ''),
      authDomain: get('FIREBASE_AUTH_DOMAIN', dev ? 'demo-timetracking.firebaseapp.com' : ''),
      projectId: get('FIREBASE_PROJECT_ID', dev ? 'demo-timetracking' : ''),
      storageBucket: get('FIREBASE_STORAGE_BUCKET', dev ? 'demo-timetracking.appspot.com' : ''),
      appId: get('FIREBASE_APP_ID', dev ? 'demo-app' : ''),
      messagingSenderId: get('FIREBASE_MESSAGING_SENDER_ID'),
    },
    emulatorHost: dev ? get('EMULATOR_HOST', '127.0.0.1') : '',
    allowedDomains: get('ALLOWED_DOMAIN'),
    oauthClientId: get('OAUTH_CLIENT_ID'),
  };
}

/** Placeholder values left in `.env.production` (`REEMPLAZAR_...`). */
export function missingFirebaseValues(cfg: BuildConfig): string[] {
  return Object.entries(cfg.firebase)
    .filter(([key, v]) => key !== 'messagingSenderId' && (v === '' || v.startsWith('REEMPLAZAR')))
    .map(([key]) => key);
}

/**
 * Options common to every build part. `outDir` overrides `outDirOf(target)`
 * (absolute or relative to `extension/`).
 */
export function baseConfig(target: BuildTarget, outDir = outDirOf(target)): InlineConfig {
  const cfg = resolveBuildConfig(target);
  return {
    root: ROOT,
    mode: viteModeOf(target),
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    resolve: { alias: { '@timetracking/shared': SHARED_ENTRY } },
    define: {
      __APP_ENV__: JSON.stringify(cfg.appEnv),
      __BUILD_CONFIG__: JSON.stringify(cfg),
    },
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome120',
      minify: cfg.appEnv === 'prod',
      sourcemap: cfg.appEnv === 'dev' ? 'inline' : false,
      modulePreload: false,
      reportCompressedSize: false,
    },
  };
}
