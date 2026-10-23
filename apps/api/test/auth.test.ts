import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { hashRefreshToken } from '../src/modules/auth/tokens';
import {
  DEFAULT_PASSWORD,
  app,
  auditEntries,
  createUser,
  login,
  refreshCookieFrom,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

const tokenFromCookie = (cookie: string) => cookie.split('=')[1]!;

describe('POST /api/auth/login', () => {
  it('returns an access token and user, and sets an httpOnly refresh cookie', async () => {
    await createUser({ role: 'CASHIER', username: 'ali' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ali', password: DEFAULT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user).toMatchObject({ username: 'ali', role: 'CASHIER', status: 'ACTIVE' });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();

    const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toMatch(/pharmacy_rt=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/);

    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'ali' } });
    expect(user.lastLoginAt).not.toBeNull();
    expect(await auditEntries('AUTH_LOGIN')).toHaveLength(1);
  });

  it('is case-insensitive on the username', async () => {
    await createUser({ role: 'CASHIER', username: 'ali' });
    const { res } = await login('  ALI ');
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS and audits it', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });

    const { res } = await login('ali', 'wrong-password');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' },
    });
    expect(refreshCookieFrom(res)).toBeUndefined();
    const [entry] = await auditEntries('AUTH_LOGIN_FAILED');
    expect(entry).toMatchObject({ userId: user.id, after: { reason: 'WRONG_PASSWORD' } });
  });

  it('gives the same answer for an unknown username', async () => {
    const { res } = await login('nobody');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    const [entry] = await auditEntries('AUTH_LOGIN_FAILED');
    expect(entry).toMatchObject({ userId: null, after: { username: 'nobody' } });
    expect(JSON.stringify(entry)).not.toContain(DEFAULT_PASSWORD);
  });

  it('rejects a deactivated account', async () => {
    await createUser({ role: 'CASHIER', username: 'ali', status: 'INACTIVE' });
    const { res } = await login('ali');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('validates the body', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'ali' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.body.fieldErrors.password).toBeDefined();
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"username": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('GET /api/auth/me (access token checks)', () => {
  it('returns the current user for a valid token', async () => {
    await createUser({ role: 'PHARMACIST', username: 'sara' });
    const { accessToken } = await login('sara');

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'sara', role: 'PHARMACIST' });
  });

  it('rejects a missing, malformed, forged or expired token', async () => {
    const user = await createUser({ role: 'ADMIN', username: 'boss' });
    const claims = { username: 'boss', role: 'ADMIN' };
    const opts = { subject: user.id, issuer: 'pharmacy-pos-api', audience: 'pharmacy-pos' };
    const forged = jwt.sign(claims, 'some-other-secret-that-is-also-long-enough!!', opts);
    const expired = jwt.sign(claims, process.env.JWT_ACCESS_SECRET!, { ...opts, expiresIn: -10 });

    for (const header of [
      undefined,
      'Bearer',
      'Basic abc',
      'Bearer not-a-jwt',
      `Bearer ${forged}`,
      `Bearer ${expired}`,
    ]) {
      const req = request(app).get('/api/auth/me');
      const res = header ? await req.set('Authorization', header) : await req;
      expect(res.status, `header: ${header}`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects a still-valid token once the user is deactivated', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });
    const { accessToken } = await login('ali');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'INACTIVE' } });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  beforeEach(() => createUser({ role: 'CASHIER', username: 'ali' }));

  it('issues a new access token and rotates the refresh cookie', async () => {
    const { refreshCookie } = await login('ali');

    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.username).toBe('ali');
    const rotated = refreshCookieFrom(res);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(refreshCookie);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);

    // The rotated cookie works in turn.
    const again = await request(app).post('/api/auth/refresh').set('Cookie', rotated!);
    expect(again.status).toBe(200);
  });

  it('rejects a request without a refresh cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app).post('/api/auth/refresh').set('Cookie', 'pharmacy_rt=made-up');
    expect(res.status).toBe(401);
  });

  it('rejects an already-rotated token', async () => {
    const { refreshCookie } = await login('ali');
    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie).expect(200);

    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('revokes the whole token family when an old token is replayed later (theft)', async () => {
    const { refreshCookie: stolen } = await login('ali');
    const first = await request(app).post('/api/auth/refresh').set('Cookie', stolen).expect(200);
    const current = refreshCookieFrom(first)!;

    // Move the rotation outside the grace window, as if the thief replays it later.
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(tokenFromCookie(stolen)) },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    await request(app).post('/api/auth/refresh').set('Cookie', stolen).expect(401);
    // The legitimate user's newer token is now revoked too.
    await request(app).post('/api/auth/refresh').set('Cookie', current).expect(401);
    expect(await auditEntries('AUTH_REFRESH_REUSE')).toHaveLength(1);
  });

  it('rejects an expired refresh token', async () => {
    const { refreshCookie } = await login('ali');
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);
    expect(res.status).toBe(401);
  });

  it('rejects refresh for a deactivated user', async () => {
    const { refreshCookie } = await login('ali');
    await prisma.user.update({ where: { username: 'ali' }, data: { status: 'INACTIVE' } });

    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token, clears the cookie and audits it', async () => {
    await createUser({ role: 'CASHIER', username: 'ali' });
    const { refreshCookie } = await login('ali');

    const res = await request(app).post('/api/auth/logout').set('Cookie', refreshCookie);

    expect(res.status).toBe(204);
    expect(refreshCookieFrom(res)).toBe('pharmacy_rt=');
    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie).expect(401);
    expect(await auditEntries('AUTH_LOGOUT')).toHaveLength(1);
  });

  it('succeeds without a cookie', async () => {
    await request(app).post('/api/auth/logout').expect(204);
  });
});

describe('unknown routes', () => {
  it('return the standard error shape', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
