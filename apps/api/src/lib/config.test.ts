import { describe, expect, it } from 'vitest';
import { refreshCookieName } from '../modules/auth/auth.controller';
import { parseEnv } from './config';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a-perfectly-random-secret-of-more-than-32-chars',
};

describe('parseEnv', () => {
  it('defaults to secure cookies, loopback-only listening and proxy trust in production', () => {
    const config = parseEnv({ ...base, NODE_ENV: 'production' });
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.TRUST_PROXY).toBe('loopback');
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.CORS_ORIGINS).toEqual([]);
  });

  it('refuses the example JWT secret in production', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'replace-with-a-random-string-of-at-least-32-characters',
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses insecure cookies in production but allows them in development', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
    expect(parseEnv({ ...base, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('never lets the cashier discount cap go above 10%', () => {
    expect(parseEnv(base).CASHIER_MAX_DISCOUNT_PERCENT).toBe(10);
    expect(
      parseEnv({ ...base, CASHIER_MAX_DISCOUNT_PERCENT: '5' }).CASHIER_MAX_DISCOUNT_PERCENT,
    ).toBe(5);
    expect(() => parseEnv({ ...base, CASHIER_MAX_DISCOUNT_PERCENT: '11' })).toThrow(
      /CASHIER_MAX_DISCOUNT_PERCENT/,
    );
  });

  it('caps token lifetimes', () => {
    expect(() => parseEnv({ ...base, JWT_ACCESS_TTL_SECONDS: '86400' })).toThrow(
      /JWT_ACCESS_TTL_SECONDS/,
    );
    expect(() => parseEnv({ ...base, REFRESH_TOKEN_TTL_DAYS: '365' })).toThrow(
      /REFRESH_TOKEN_TTL_DAYS/,
    );
  });

  it('parses CORS_ORIGINS and the trust proxy setting', () => {
    const config = parseEnv({
      ...base,
      CORS_ORIGINS: 'https://a.example, https://b.example:8443,',
      TRUST_PROXY: '1',
    });
    expect(config.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example:8443']);
    expect(config.TRUST_PROXY).toBe(1);
    expect(() => parseEnv({ ...base, CORS_ORIGINS: 'not a url' })).toThrow(/CORS_ORIGINS/);
  });

  it('never prints values in its error', () => {
    try {
      parseEnv({ DATABASE_URL: 'postgresql://u:hunter2@x/db', JWT_ACCESS_SECRET: 'short' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).not.toContain('short');
    }
  });
});

describe('refresh cookie name', () => {
  it('uses the __Secure- prefix over HTTPS', () => {
    expect(refreshCookieName(true)).toBe('__Secure-pharmacy_rt');
    expect(refreshCookieName(false)).toBe('pharmacy_rt');
  });
});
