import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Config is validated at import time, so the test env must be complete.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://nexs:nexs@localhost:5433/nexs_test?schema=public',
      JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-chars-long',
      LOG_LEVEL: 'silent',
      WORKER_ENABLED: 'false',
    },
  },
});
