import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './lib/config';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import {
  apiRateLimit,
  loginRateLimits,
  noStore,
  originGuard,
  type RateLimitOptions,
  securityHeaders,
} from './middleware/security';
import { alertsRouter } from './modules/alerts/alerts.routes';
import { authRouter } from './modules/auth/auth.routes';
import { categoriesRouter } from './modules/categories/categories.routes';
import { healthRouter } from './modules/health/health.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';
import { legacyRouter } from './modules/legacy/legacy.routes';
import { medicinesRouter } from './modules/medicines/medicines.routes';
import { offlineSalesRouter } from './modules/offline-sales/offline-sales.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { returnsRouter } from './modules/returns/returns.routes';
import { salesRouter } from './modules/sales/sales.routes';
import { suppliersRouter } from './modules/suppliers/suppliers.routes';
import { usersRouter } from './modules/users/users.routes';

/** Largest JSON body accepted. A 100-line sale is well under 20 kB. */
export const JSON_BODY_LIMIT = '100kb';

export type AppOptions = {
  rateLimit: RateLimitOptions;
  corsOrigins: readonly string[];
};

const defaultOptions = (): AppOptions => ({
  rateLimit: {
    enabled: config.RATE_LIMIT_ENABLED,
    apiPerMinute: config.RATE_LIMIT_API_PER_MINUTE,
    loginAttempts: config.RATE_LIMIT_LOGIN_ATTEMPTS,
    loginWindowMinutes: config.RATE_LIMIT_LOGIN_WINDOW_MINUTES,
  },
  corsOrigins: config.CORS_ORIGINS,
});

/**
 * Builds the Express app without listening, so tests can drive it with
 * Supertest. Options default to the environment; tests override them. Rate
 * limit counters live in the app instance (one process, see ecosystem.config.cjs).
 */
export function createApp(overrides: Partial<AppOptions> = {}) {
  const options = { ...defaultOptions(), ...overrides };
  const app = express();

  app.disable('x-powered-by');
  // Behind Nginx: req.ip and req.protocol come from X-Forwarded-* set by the proxy.
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );
  app.use(securityHeaders());
  app.use('/api', noStore, originGuard(options.corsOrigins), apiRateLimit(options.rateLimit));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use('/api/health', healthRouter);
  // Connectivity probe for offline billing: answers as soon as the API is up,
  // without touching the database or needing a session.
  app.get('/api/ping', (_req, res) => {
    res.status(204).end();
  });
  app.use('/api/auth/login', ...loginRateLimits(options.rateLimit));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/medicines', medicinesRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/sales', salesRouter);
  app.use('/api/returns', returnsRouter);
  app.use('/api/offline-sales', offlineSalesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/legacy', legacyRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
