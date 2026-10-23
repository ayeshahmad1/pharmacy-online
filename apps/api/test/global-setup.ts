import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL, assertIsTestDatabase } from './test-env';

/** Creates the test database if needed and applies all migrations, once per run. */
export default function setup() {
  assertIsTestDatabase(TEST_DATABASE_URL);
  execSync('npx prisma migrate deploy', {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
