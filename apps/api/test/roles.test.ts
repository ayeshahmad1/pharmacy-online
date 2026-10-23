import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticate, requireRole } from '../src/middleware/auth';
import { prisma } from '../src/lib/prisma';
import { errorHandler } from '../src/middleware/error-handler';
import { app, authAs, createUser, resetDatabase } from './helpers';

beforeEach(resetDatabase);

describe('user management is ADMIN only', () => {
  const adminEndpoints = (targetId: string) =>
    [
      { method: 'get', path: '/api/users' },
      {
        method: 'post',
        path: '/api/users',
        body: { username: 'x', fullName: 'X', role: 'CASHIER', password: 'Password1!' },
      },
      { method: 'get', path: `/api/users/${targetId}` },
      { method: 'patch', path: `/api/users/${targetId}`, body: { role: 'ADMIN' } },
      { method: 'post', path: `/api/users/${targetId}/deactivate` },
      { method: 'post', path: `/api/users/${targetId}/activate` },
      {
        method: 'post',
        path: `/api/users/${targetId}/reset-password`,
        body: { newPassword: 'Password1!' },
      },
    ] as const;

  it.each(['CASHIER', 'PHARMACIST'] as const)('a %s gets 403 on every endpoint', async (role) => {
    const { auth } = await authAs(role);
    const target = await createUser({ role: 'CASHIER', username: 'target' });

    for (const ep of adminEndpoints(target.id)) {
      const req = request(app)[ep.method](ep.path).set('Authorization', auth);
      const res = 'body' in ep ? await req.send(ep.body) : await req;
      expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    // Nothing was changed by the rejected calls.
    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
      include: { role: true },
    });
    expect(unchanged).toMatchObject({ status: 'ACTIVE', role: { code: 'CASHIER' } });
    expect(unchanged.passwordHash).toBe(target.passwordHash);
    expect(await prisma.user.findUnique({ where: { username: 'x' } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'USER_' } } })).toBe(0);
  });

  it('an unauthenticated caller gets 401', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('an ADMIN is allowed', async () => {
    const { auth } = await authAs('ADMIN');
    const res = await request(app).get('/api/users').set('Authorization', auth);
    expect(res.status).toBe(200);
  });

  it('a role change takes effect on the next request, without a new token', async () => {
    const { user, auth } = await authAs('ADMIN', 'boss');
    await request(app).get('/api/users').set('Authorization', auth).expect(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { role: { connect: { code: 'CASHIER' } } },
    });

    await request(app).get('/api/users').set('Authorization', auth).expect(403);
  });
});

describe('requireRole with several roles', () => {
  // A stand-in for later modules, e.g. inventory: ADMIN and PHARMACIST only.
  const mini = express();
  mini.get('/inventory', authenticate, requireRole('ADMIN', 'PHARMACIST'), (_req, res) => {
    res.json({ ok: true });
  });
  mini.use(errorHandler);

  it.each([
    ['ADMIN', 200],
    ['PHARMACIST', 200],
    ['CASHIER', 403],
  ] as const)('%s -> %i', async (role, status) => {
    const { auth } = await authAs(role);
    const res = await request(mini).get('/inventory').set('Authorization', auth);
    expect(res.status).toBe(status);
  });
});
