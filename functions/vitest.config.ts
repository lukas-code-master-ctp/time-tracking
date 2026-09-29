import { defineConfig } from 'vitest/config';

// Pure unit tests (no emulator).
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
