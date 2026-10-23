// Integration tests run against a separate database on the docker-compose
// Postgres. It is wiped before every test, so it must never be the dev database.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://pharmacy:pharmacy_dev@localhost:5433/pharmacy_pos_test?schema=public';

export function assertIsTestDatabase(url: string) {
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${dbName}": name must end in _test`);
  }
}
