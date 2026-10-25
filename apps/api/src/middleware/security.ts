import type { ApiErrorBody } from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, type RateLimitExceededEventHandler, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { forbidden } from '../lib/errors';

/**
 * Security headers for API responses. The API only returns JSON and CSV, so
 * the policy allows nothing to load or frame it. The web app's own headers
 * (its CSP, HSTS for the static files) are set by Nginx.
 */
export const securityHeaders = () =>
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });

/**
 * API responses carry sales, stock and staff data: no browser or proxy cache
 * may keep them. Routes may still override this.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * Strict CORS. The web app is served from the same origin as the API, so a
 * browser request whose Origin is anything else is refused outright (403),
 * unless it is listed in CORS_ORIGINS. Requests without an Origin header
 * (same-origin GETs, curl, health checks) pass.
 *
 * "Same origin" is judged from the Host and protocol the browser used, which
 * Nginx (and the Vite dev proxy) forward and `trust proxy` lets Express read.
 */
export function originGuard(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));

  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin || origin === `${req.protocol}://${req.host}`) {
      next();
      return;
    }
    if (!allowed.has(origin)) throw forbidden('Cross-origin requests are not allowed');

    res.vary('Origin');
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, Retry-After, X-Request-Id');
    next();
  };
}

export type RateLimitOptions = {
  enabled: boolean;
  /** Requests per minute per client IP across the API. */
  apiPerMinute: number;
  /** Failed logins per username and IP within the window. */
  loginAttempts: number;
  loginWindowMinutes: number;
};

const limitReached =
  (message: string): RateLimitExceededEventHandler =>
  (_req, res, _next, options) => {
    const body: ApiErrorBody = { error: { code: 'RATE_LIMITED', message } };
    res.status(options.statusCode).json(body);
  };

const passThrough: RequestHandler = (_req, _res, next) => next();

// Health checks are polled by monitoring and must never be throttled.
const isHealthCheck = (req: Request) => req.originalUrl.startsWith('/api/health');

/** One limiter for every API request, per client IP (IPv6 by /56 subnet). */
export function apiRateLimit(opts: RateLimitOptions): RequestHandler {
  if (!opts.enabled) return passThrough;
  return rateLimit({
    windowMs: 60_000,
    limit: opts.apiPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: isHealthCheck,
    handler: limitReached('Too many requests. Please wait a moment and try again.'),
  });
}

/**
 * Login brute-force protection. Only failed attempts count, so staff signing
 * in all day are never blocked. Keyed by username and IP: the tills share the
 * pharmacy's IP, and someone guessing elsewhere can't lock them out. A looser
 * per-IP cap catches one address trying many usernames.
 */
export function loginRateLimits(opts: RateLimitOptions): RequestHandler[] {
  if (!opts.enabled) return [passThrough];
  const windowMs = opts.loginWindowMinutes * 60_000;
  const handler = limitReached(
    `Too many failed sign-in attempts. Try again in ${opts.loginWindowMinutes} minutes.`,
  );
  const ip = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');
  const common = {
    windowMs,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler,
  } as const;

  return [
    rateLimit({ ...common, limit: opts.loginAttempts * 5, keyGenerator: ip }),
    rateLimit({
      ...common,
      limit: opts.loginAttempts,
      keyGenerator: (req) => `${ip(req)}|${loginUsername(req)}`,
    }),
  ];
}

/** The username as login will read it (trimmed, lowercase), before validation runs. */
function loginUsername(req: Request): string {
  const body: unknown = req.body;
  const username =
    typeof body === 'object' && body !== null && 'username' in body ? body.username : undefined;
  return typeof username === 'string' ? username.trim().toLowerCase().slice(0, 64) : '';
}
