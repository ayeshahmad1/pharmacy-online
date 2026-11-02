import { validate as isValidCron } from 'node-cron';
import { MAX_CASHIER_DISCOUNT_PERCENT } from '@pharmacy/shared';
import { z } from 'zod';

// Load apps/api/.env in development. In production, PM2 starts Node with
// --env-file (see ecosystem.config.cjs); in tests, vitest.config.ts sets it.
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment.
  }
}

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Comma-separated list, e.g. "https://a.example,https://b.example". Blank entries are dropped. */
const listString = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })));

/** The value shipped in .env.example. Running production with it would let anyone forge tokens. */
const EXAMPLE_JWT_SECRET = 'replace-with-a-random-string-of-at-least-32-characters';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    /** Interface to listen on. Nginx proxies from the same machine, so loopback is enough. */
    HOST: z.string().min(1).default('127.0.0.1'),
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(60 * 60, 'Access tokens may live at most an hour')
      .default(15 * 60),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    /** Send the refresh cookie only over HTTPS. Defaults to true in production, where false is refused. */
    COOKIE_SECURE: booleanString.optional(),

    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

    /**
     * Express "trust proxy": which hops may set X-Forwarded-For/-Proto/-Host.
     * Nginx runs on the same machine, so only loopback is trusted. Decides
     * req.ip (rate limits, audit log) and req.protocol.
     */
    TRUST_PROXY: z.string().trim().min(1).default('loopback'),
    /**
     * Origins other than the app's own that may call the API from a browser.
     * The web app is served from the same origin, so this is normally empty.
     */
    CORS_ORIGINS: listString.default([]),

    /** Turns the API's own rate limits off (tests). Nginx limits still apply. */
    RATE_LIMIT_ENABLED: booleanString.default(true),
    /** Requests per minute per client IP across the whole API. A pharmacy's tills share one IP. */
    RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(10).default(600),
    /** Failed logins allowed per username and IP within the window. */
    RATE_LIMIT_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),

    /** Sentry DSN. Unset: errors are only logged. */
    SENTRY_DSN: z.url().optional(),
    SENTRY_ENVIRONMENT: z.string().trim().min(1).optional(),
    /** Release identifier (the deploy script sets the git commit). Shown by /api/health. */
    APP_RELEASE: z.string().trim().min(1).optional(),

    /** IANA timezone of the pharmacy. Decides what "today" is for expiry checks. */
    BUSINESS_TIMEZONE: z
      .string()
      .default('Asia/Karachi')
      .refine(isValidTimeZone, 'Must be an IANA timezone such as Asia/Karachi'),
    /** Default window for the expiring-soon list, in days. */
    EXPIRY_WARNING_DAYS: z.coerce.number().int().min(1).max(730).default(90),

    /**
     * Largest total discount a cashier may give, as a percent of the bill
     * subtotal. It may be lowered but never set above 10%.
     */
    CASHIER_MAX_DISCOUNT_PERCENT: z.coerce
      .number()
      .int()
      .min(0)
      .max(
        MAX_CASHIER_DISCOUNT_PERCENT,
        `Cashiers may give at most ${MAX_CASHIER_DISCOUNT_PERCENT}% discount; set ${MAX_CASHIER_DISCOUNT_PERCENT} or less`,
      )
      .default(MAX_CASHIER_DISCOUNT_PERCENT),
    /** Offline sales reaching the server later than this after they were made are refused. */
    OFFLINE_SALE_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(90).default(7),

    /**
     * When the alerts job re-checks stock and expiry (cron syntax, in
     * BUSINESS_TIMEZONE). It also runs once at startup. "off" disables it.
     */
    ALERTS_CRON: z
      .string()
      .trim()
      .default('*/15 * * * *')
      .refine((v) => v === 'off' || isValidCron(v), 'Must be a cron expression or "off"'),
    /** Batches with stock expiring within this many days raise an alert. */
    ALERT_EXPIRY_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** A medicine in stock with no sale for this many days counts as dead stock. */
    DEAD_STOCK_DAYS: z.coerce.number().int().min(7).max(730).default(60),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // Production refuses settings that are only safe on a developer's machine.
    if (env.JWT_ACCESS_SECRET === EXAMPLE_JWT_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'Still the example value; generate a random secret',
      });
    }
    if (env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'Must not be false in production (the app is served over HTTPS)',
      });
    }
  });

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Express accepts a boolean, a hop count, or address/subnet names for "trust proxy". */
function trustProxySetting(value: string): boolean | number | string {
  if (value === 'true' || value === 'false') return value === 'true';
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Validates an environment. Exported for tests; the app uses `config`. */
export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Only variable names and messages are printed, never values.
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }

  const env = parsed.data;
  return {
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    TRUST_PROXY: trustProxySetting(env.TRUST_PROXY),
  };
}

export type Config = ReturnType<typeof parseEnv>;

export const config: Config = parseEnv(process.env);
