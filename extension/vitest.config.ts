import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@timetracking/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  define: {
    __APP_ENV__: JSON.stringify('dev'),
    __BUILD_CONFIG__: JSON.stringify({
      appEnv: 'dev',
      firebase: { apiKey: 'x', authDomain: 'x', projectId: 'demo-timetracking', storageBucket: 'b', appId: 'x', messagingSenderId: '' },
      emulatorHost: '127.0.0.1',
      allowedDomains: '',
      oauthClientId: '',
    }),
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Needs the emulators: `npm run test:emulator` (root).
    exclude: ['test/emulator/**', '**/node_modules/**'],
    environment: 'node',
  },
});
