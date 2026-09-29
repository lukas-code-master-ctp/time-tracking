import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Runs inside `firebase emulators:exec` (auth, firestore, storage…), see the
// root `test:emulator` script. Talks to the real emulators over HTTP.
// Built from the unit config (alias + defines), replacing the test options:
// mergeConfig would concatenate `include`/`exclude` with the unit ones.
export default defineConfig({
  ...base,
  test: {
    include: ['test/emulator/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
