import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/test-env';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database, so they must not run concurrently.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_ACCESS_SECRET: 'test-only-secret-that-is-at-least-32-characters-long',
      JWT_ACCESS_TTL_SECONDS: '900',
      REFRESH_TOKEN_TTL_DAYS: '7',
      COOKIE_SECURE: 'false',
      // Lowest cost bcrypt allows, to keep the suite fast.
      BCRYPT_ROUNDS: '4',
    },
  },
});
