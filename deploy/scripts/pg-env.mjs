#!/usr/bin/env node
// Runs a Postgres client tool (pg_dump, pg_restore, psql) against the app's
// database without the password ever appearing on a command line (where any
// local user could read it from `ps`): DATABASE_URL is read from the API's
// env file and handed to the tool as PG* environment variables. Nothing else
// from that file (JWT secret etc.) is passed on.
//
// Usage: node pg-env.mjs <api-env-file> <command> [args...]
//   e.g. node pg-env.mjs /opt/pharmacy-pos/shared/api.env pg_dump --format=custom -f out.dump

import { spawn } from 'node:child_process';

const [envFile, command, ...args] = process.argv.slice(2);
if (!envFile || !command) {
  console.error('Usage: node pg-env.mjs <api-env-file> <command> [args...]');
  process.exit(64);
}

const baseEnv = { ...process.env };
process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) {
  console.error(`DATABASE_URL is not set in ${envFile}`);
  process.exit(78);
}

const url = new URL(process.env.DATABASE_URL);
const env = {
  ...baseEnv,
  PGHOST: url.searchParams.get('host') || url.hostname || 'localhost',
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
};
const sslmode = url.searchParams.get('sslmode');
if (sslmode) env.PGSSLMODE = sslmode;

const child = spawn(command, args, { stdio: 'inherit', env });
child.on('error', (err) => {
  console.error(`${command}: ${err.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
