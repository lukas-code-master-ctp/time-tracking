import { defineConfig } from 'vitest/config';

// Rules tests share one emulator instance and clear its data between tests,
// so files must run one after another.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
