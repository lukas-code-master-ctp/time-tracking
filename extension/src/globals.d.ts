/** Build-time constants injected by Vite `define` (see build/common.ts). */

/** 'dev' = emulators + dev login; 'prod' = real Firebase project. Replaced literally, so dev-only branches are dropped from prod bundles. */
declare const __APP_ENV__: 'dev' | 'prod';

declare const __BUILD_CONFIG__: {
  appEnv: 'dev' | 'prod';
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    appId: string;
    messagingSenderId: string;
  };
  emulatorHost: string;
  /** Raw comma separated list from `VITE_ALLOWED_DOMAIN` (empty = defaults). */
  allowedDomains: string;
  oauthClientId: string;
};

/** Side-effect CSS imports (bundled by Vite). */
declare module '*.css';
