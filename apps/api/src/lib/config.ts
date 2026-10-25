import { validate as isValidCron } from 'node-cron';
import { z } from 'zod';

// Load apps/api/.env in development. In production, PM2 provides the
// environment; in tests, vitest.config.ts does.
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment.
  }
}

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /** Send the refresh cookie only over HTTPS. Defaults to true in production. */
  COOKIE_SECURE: booleanString.optional(),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  /** IANA timezone of the pharmacy. Decides what "today" is for expiry checks. */
  BUSINESS_TIMEZONE: z
    .string()
    .default('Asia/Karachi')
    .refine(isValidTimeZone, 'Must be an IANA timezone such as Asia/Karachi'),
  /** Default window for the expiring-soon list, in days. */
  EXPIRY_WARNING_DAYS: z.coerce.number().int().min(1).max(730).default(90),

  /** Largest total discount a cashier may give, as a percent of the bill subtotal. */
  CASHIER_MAX_DISCOUNT_PERCENT: z.coerce.number().int().min(0).max(100).default(10),
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
});

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Only variable names and messages are printed, never values.
  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
}

const env = parsed.data;

export const config = {
  ...env,
  COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
};
