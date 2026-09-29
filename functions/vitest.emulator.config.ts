import { defineConfig } from 'vitest/config';

// Runs inside `firebase emulators:exec` (auth, firestore, storage, functions).
// Files share the emulators and clear their data between tests, so they run
// one after another.
export default defineConfig({
  test: {
    include: ['test/emulator/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
