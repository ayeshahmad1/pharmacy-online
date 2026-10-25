import type { RequestHandler } from 'express';
import { config } from '../../lib/config';
import { prisma } from '../../lib/prisma';

const DB_TIMEOUT_MS = 2000;

/** Liveness: the process is up and serving requests. Never touches the database. */
export const live: RequestHandler = (_req, res) => {
  res.json({
    status: 'ok',
    release: config.APP_RELEASE ?? null,
    uptimeSeconds: Math.round(process.uptime()),
  });
};

/**
 * Readiness: the API can do real work, i.e. Postgres answers within 2 s.
 * 503 otherwise, so the deploy script rolls back and monitors alert. The
 * database error itself is logged, never returned.
 */
export const ready: RequestHandler = async (req, res) => {
  let database: 'ok' | 'unavailable' = 'ok';
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS);
  } catch (err) {
    req.log?.warn({ err }, 'Readiness check: database unavailable');
    database = 'unavailable';
  }
  const ok = database === 'ok';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'unavailable',
    release: config.APP_RELEASE ?? null,
    checks: { database },
  });
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
