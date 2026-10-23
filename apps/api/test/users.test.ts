import bcrypt from 'bcrypt';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, auditEntries, authAs, createUser, login, resetDatabase } from './helpers';

let admin: Awaited<ReturnType<typeof authAs>>;

beforeEach(async () => {
  await resetDatabase();
  admin = await authAs('ADMIN', 'boss');
});

const api = {
  get: (path: string) => request(app).get(path).set('Authorization', admin.auth),
  post: (path: string, body?: object) =>
    request(app).post(path).set('Authorization', admin.auth).send(body),
  patch: (path: string, body: object) =>
    request(app).patch(path).set('Authorization', admin.auth).send(body),
};

describe('POST /api/users', () => {
  const newUser = {
    username: 'New.Cashier',
    fullName: 'Ayesha Khan',
    email: 'Ayesha@Example.com',
    role: 'CASHIER',
    password: 'Str0ng-pass',
  };

  it('creates a user with a bcrypt hash and audits it without the hash', async () => {
    const res = await api.post('/api/users', newUser);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      username: 'new.cashier',
      email: 'ayesha@example.com',
      role: 'CASHIER',
      status: 'ACTIVE',
    });
    expect(res.body.user.passwordHash).toBeUndefined();

    const row = await prisma.user.findUniqueOrThrow({ where: { username: 'new.cashier' } });
    expect(row.passwordHash).not.toBe(newUser.password);
    expect(await bcrypt.compare(newUser.password, row.passwordHash)).toBe(true);

    const [entry] = await auditEntries('USER_CREATE');
    expect(entry).toMatchObject({ userId: admin.user.id, entityId: row.id });
    expect(JSON.stringify(entry)).not.toMatch(/passwordHash|Str0ng-pass/);

    const { res: loginRes } = await login('new.cashier', newUser.password);
    expect(loginRes.status).toBe(200);
  });

  it('rejects a duplicate username with 409', async () => {
    await api.post('/api/users', newUser).expect(201);
    const res = await api.post('/api/users', { ...newUser, email: undefined });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['a password over 72 bytes', { password: 'é'.repeat(40) }],
    ['an invalid username', { username: 'has space' }],
    ['an unknown role', { role: 'OWNER' }],
    ['an invalid email', { email: 'not-an-email' }],
    ['an unexpected field', { status: 'INACTIVE' }],
  ])('rejects %s', async (_label, override) => {
    const res = await api.post('/api/users', { ...newUser, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/users', () => {
  beforeEach(async () => {
    await createUser({ role: 'CASHIER', username: 'cashier1' });
    await createUser({ role: 'CASHIER', username: 'cashier2', status: 'INACTIVE' });
    await createUser({ role: 'PHARMACIST', username: 'pharma' });
  });

  it('lists users with pagination', async () => {
    const res = await api.get('/api/users?page=1&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(res.body.items.map((u: { username: string }) => u.username)).toEqual([
      'boss',
      'cashier1',
    ]);
  });

  it('filters by role, status and search text', async () => {
    const res = await api.get('/api/users?role=CASHIER&status=ACTIVE');
    expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['cashier1']);

    const search = await api.get('/api/users?q=PHAR');
    expect(search.body.items.map((u: { username: string }) => u.username)).toEqual(['pharma']);
  });

  it('rejects an invalid query', async () => {
    const res = await api.get('/api/users?pageSize=1000');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/users/:id', () => {
  it('returns 404 for an unknown id and 400 for a non-uuid', async () => {
    await api.get('/api/users/7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f').expect(404);
    const res = await api.get('/api/users/123');
    expect(res.status).toBe(400);
    expect(res.body.error.details.params).toBeDefined();
  });
});

describe('PATCH /api/users/:id', () => {
  it('updates fields and audits before/after', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });

    const res = await api.patch(`/api/users/${user.id}`, {
      fullName: 'Ali Raza',
      role: 'PHARMACIST',
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ fullName: 'Ali Raza', role: 'PHARMACIST' });
    const [entry] = await auditEntries('USER_UPDATE');
    expect(entry).toMatchObject({
      before: { fullName: 'Test ali', role: 'CASHIER' },
      after: { fullName: 'Ali Raza', role: 'PHARMACIST' },
    });
  });

  it('does not let an admin change their own role', async () => {
    const res = await api.patch(`/api/users/${admin.user.id}`, { role: 'CASHIER' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty update and attempts to set the password', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });
    await api.patch(`/api/users/${user.id}`, {}).expect(400);
    await api.patch(`/api/users/${user.id}`, { password: 'Password123' }).expect(400);
  });
});

describe('deactivate / activate', () => {
  it('blocks login and revokes existing sessions', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });
    const { refreshCookie } = await login('ali');

    const res = await api.post(`/api/users/${user.id}/deactivate`);

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('INACTIVE');
    expect((await login('ali')).res.status).toBe(403);
    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie).expect(401);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      0,
    );
    expect(await auditEntries('USER_DEACTIVATE')).toHaveLength(1);

    await api.post(`/api/users/${user.id}/activate`).expect(200);
    expect((await login('ali')).res.status).toBe(200);
    expect(await auditEntries('USER_ACTIVATE')).toHaveLength(1);
  });

  it('does not let an admin deactivate themselves', async () => {
    const res = await api.post(`/api/users/${admin.user.id}/deactivate`);
    expect(res.status).toBe(400);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } });
    expect(me.status).toBe('ACTIVE');
  });
});

describe('POST /api/users/:id/reset-password', () => {
  it('sets the new password, revokes sessions and audits without secrets', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });
    const { refreshCookie } = await login('ali');

    const res = await api.post(`/api/users/${user.id}/reset-password`, {
      newPassword: 'Brand-new-1',
    });

    expect(res.status).toBe(204);
    expect((await login('ali')).res.status).toBe(401);
    expect((await login('ali', 'Brand-new-1')).res.status).toBe(200);
    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie).expect(401);

    const [entry] = await auditEntries('USER_PASSWORD_RESET');
    expect(entry).toMatchObject({ userId: admin.user.id, entityId: user.id });
    expect(JSON.stringify(entry)).not.toContain('Brand-new-1');
  });

  it('applies the password policy', async () => {
    const user = await createUser({ role: 'CASHIER', username: 'ali' });
    await api.post(`/api/users/${user.id}/reset-password`, { newPassword: '123' }).expect(400);
  });
});
