import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { setErrorReporter } from '../src/lib/error-reporting';
import type { RateLimitOptions } from '../src/middleware/security';
import { DEFAULT_PASSWORD, app, authAs, createUser, resetDatabase } from './helpers';

beforeEach(resetDatabase);

const limits = (overrides: Partial<RateLimitOptions> = {}): RateLimitOptions => ({
  enabled: true,
  apiPerMinute: 1000,
  loginAttempts: 3,
  loginWindowMinutes: 15,
  ...overrides,
});

const badLogin = (target: ReturnType<typeof createApp>, username: string) =>
  request(target).post('/api/auth/login').send({ username, password: 'wrong-password' });

describe('security headers', () => {
  it('sends helmet headers, no-store and no X-Powered-By on API responses', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('request size limit', () => {
  it('refuses a JSON body over 100 kB with 413 PAYLOAD_TOO_LARGE', async () => {
    const { auth } = await authAs('ADMIN');
    const res = await request(app)
      .post('/api/categories')
      .set('Authorization', auth)
      .send({ name: 'x'.repeat(110 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('strict CORS', () => {
  it('refuses a browser request from another origin', async () => {
    await createUser({ role: 'CASHIER', username: 'ali' });
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'ali', password: DEFAULT_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses the preflight from another origin', async () => {
    const res = await request(app)
      .options('/api/sales')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows the same origin, as forwarded by the reverse proxy', async () => {
    await createUser({ role: 'CASHIER', username: 'ali' });
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://pos.example.com')
      .set('X-Forwarded-Host', 'pos.example.com')
      .set('X-Forwarded-Proto', 'https')
      .send({ username: 'ali', password: DEFAULT_PASSWORD });

    expect(res.status).toBe(200);
  });

  it('does not let a spoofed Host over plain HTTP pass for an HTTPS origin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://pos.example.com')
      .set('X-Forwarded-Host', 'pos.example.com')
      .send({ username: 'ali', password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('answers the preflight for an origin listed in CORS_ORIGINS', async () => {
    const custom = createApp({ corsOrigins: ['https://hq.example.com'] });
    const res = await request(custom)
      .options('/api/sales')
      .set('Origin', 'https://hq.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://hq.example.com');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers.vary).toContain('Origin');
  });
});

describe('login rate limit', () => {
  it('blocks a username after too many failed attempts, with Retry-After', async () => {
    const limited = createApp({ rateLimit: limits() });
    await createUser({ role: 'CASHIER', username: 'ali' });

    for (let i = 0; i < 3; i++) expect((await badLogin(limited, 'ali')).status).toBe(401);
    const blocked = await badLogin(limited, 'ali');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Even the right password waits out the window: that is the point.
    const right = await request(limited)
      .post('/api/auth/login')
      .send({ username: 'ALI ', password: DEFAULT_PASSWORD });
    expect(right.status).toBe(429);
  });

  it('does not lock other staff out, and does not count successful logins', async () => {
    const limited = createApp({ rateLimit: limits() });
    await createUser({ role: 'CASHIER', username: 'ali' });
    await createUser({ role: 'CASHIER', username: 'sara' });

    for (let i = 0; i < 3; i++) await badLogin(limited, 'ali');
    for (let i = 0; i < 5; i++) {
      const ok = await request(limited)
        .post('/api/auth/login')
        .send({ username: 'sara', password: DEFAULT_PASSWORD });
      expect(ok.status).toBe(200);
    }
  });

  it('caps failed logins per IP across usernames', async () => {
    const limited = createApp({ rateLimit: limits({ loginAttempts: 1 }) });
    // Per-IP cap is five times the per-username one.
    for (let i = 0; i < 5; i++) expect((await badLogin(limited, `user${i}`)).status).toBe(401);
    expect((await badLogin(limited, 'user9')).status).toBe(429);
  });
});

describe('API rate limit', () => {
  it('limits requests per IP per minute but never the health checks', async () => {
    const limited = createApp({ rateLimit: limits({ apiPerMinute: 10 }) });

    for (let i = 0; i < 10; i++) await request(limited).get('/api/ping');
    const blocked = await request(limited).get('/api/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    expect((await request(limited).get('/api/health')).status).toBe(200);
  });
});

describe('health checks', () => {
  it('GET /api/health answers without a session or the database', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', uptimeSeconds: expect.any(Number) });
  });

  it('GET /api/health/ready checks the database', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });
});

describe('error reporting', () => {
  afterEach(() => setErrorReporter(null));

  it('reports 5xx errors with request context only, never 4xx', async () => {
    const capture = vi.fn();
    setErrorReporter({ capture, flush: () => Promise.resolve() });
    const { auth, user } = await authAs('ADMIN');

    await request(app).get('/api/sales/not-a-uuid').set('Authorization', auth); // 400
    expect(capture).not.toHaveBeenCalled();

    // Simulate a database outage mid-request.
    const { prisma } = await import('../src/lib/prisma');
    const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/categories?q=secret').set('Authorization', auth);
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Something went wrong');
    expect(capture).toHaveBeenCalledTimes(1);
    const [err, context] = capture.mock.calls[0]!;
    expect((err as Error).message).toBe('db down');
    expect(context).toEqual({
      source: 'http',
      requestId: expect.any(String),
      userId: user.id,
      role: 'ADMIN',
      method: 'GET',
      path: '/api/categories',
    });
  });
});
