import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration and concurrency tests share one PostgreSQL database and
    // truncate between cases, so they must not run in parallel with each other.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    reporters: ['default'],
  },
});
