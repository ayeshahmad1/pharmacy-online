import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  authAs,
  createCategory,
  createMedicine,
  createSupplier,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

type Endpoint = { method: 'get' | 'post' | 'patch'; path: string; body?: object };

/** Creates one record of each kind and lists the read and write endpoints for it. */
async function fixtures() {
  const category = await createCategory('Tablets');
  const supplier = await createSupplier('Pak Pharma');
  const medicine = await createMedicine({ name: 'Panadol 500mg', categoryId: category.id });

  const reads: Endpoint[] = [
    { method: 'get', path: '/api/categories' },
    { method: 'get', path: `/api/categories/${category.id}` },
    { method: 'get', path: '/api/suppliers' },
    { method: 'get', path: `/api/suppliers/${supplier.id}` },
    { method: 'get', path: '/api/medicines' },
    { method: 'get', path: '/api/medicines?q=pana' },
    { method: 'get', path: `/api/medicines/${medicine.id}` },
  ];

  const writes: Endpoint[] = [
    { method: 'post', path: '/api/categories', body: { name: 'Syrups' } },
    { method: 'patch', path: `/api/categories/${category.id}`, body: { name: 'Renamed' } },
    { method: 'post', path: `/api/categories/${category.id}/deactivate` },
    { method: 'post', path: `/api/categories/${category.id}/activate` },
    { method: 'post', path: '/api/suppliers', body: { name: 'New Supplier' } },
    { method: 'patch', path: `/api/suppliers/${supplier.id}`, body: { phone: '0300 1234567' } },
    { method: 'post', path: `/api/suppliers/${supplier.id}/deactivate` },
    { method: 'post', path: `/api/suppliers/${supplier.id}/activate` },
    {
      method: 'post',
      path: '/api/medicines',
      body: { name: 'Brufen', categoryId: category.id, unit: 'tablet', sellingPrice: '5.00' },
    },
    { method: 'patch', path: `/api/medicines/${medicine.id}`, body: { sellingPrice: '1.00' } },
    { method: 'post', path: `/api/medicines/${medicine.id}/deactivate` },
    { method: 'post', path: `/api/medicines/${medicine.id}/activate` },
  ];

  return { category, supplier, medicine, reads, writes };
}

function send(ep: Endpoint, auth?: string) {
  const req = request(app)[ep.method](ep.path);
  if (auth) req.set('Authorization', auth);
  return ep.body ? req.send(ep.body) : req;
}

describe('catalogue permissions', () => {
  it('a CASHIER can read medicines, categories and suppliers', async () => {
    const { auth } = await authAs('CASHIER');
    const { reads } = await fixtures();

    for (const ep of reads) {
      const res = await send(ep, auth);
      expect(res.status, `GET ${ep.path}`).toBe(200);
    }
  });

  it('a CASHIER gets 403 on every write, and nothing changes', async () => {
    const { auth } = await authAs('CASHIER');
    const { category, supplier, medicine, writes } = await fixtures();

    for (const ep of writes) {
      const res = await send(ep, auth);
      expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    expect(await prisma.category.findMany()).toEqual([category]);
    expect(await prisma.supplier.findMany()).toEqual([supplier]);
    expect(await prisma.medicine.findMany()).toEqual([medicine]);
    expect(await prisma.auditLog.count({ where: { action: { not: 'AUTH_LOGIN' } } })).toBe(0);
  });

  it('a CASHIER gets 403 even when the write body is invalid (role is checked first)', async () => {
    const { auth } = await authAs('CASHIER');
    const res = await request(app).post('/api/medicines').set('Authorization', auth).send({});
    expect(res.status).toBe(403);
  });

  it.each(['ADMIN', 'PHARMACIST'] as const)(
    'a %s can perform every write, each one audited',
    async (role) => {
      const { user, auth } = await authAs(role);
      const { writes } = await fixtures();

      for (const ep of writes) {
        const res = await send(ep, auth);
        expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBeLessThan(300);
      }

      const audit = await prisma.auditLog.findMany({
        where: { action: { not: 'AUTH_LOGIN' } },
      });
      expect(audit.map((a) => a.action).sort()).toEqual(
        [
          'CATEGORY_CREATE',
          'CATEGORY_UPDATE',
          'CATEGORY_DEACTIVATE',
          'CATEGORY_ACTIVATE',
          'SUPPLIER_CREATE',
          'SUPPLIER_UPDATE',
          'SUPPLIER_DEACTIVATE',
          'SUPPLIER_ACTIVATE',
          'MEDICINE_CREATE',
          'MEDICINE_UPDATE',
          'MEDICINE_DEACTIVATE',
          'MEDICINE_ACTIVATE',
        ].sort(),
      );
      expect(audit.every((a) => a.userId === user.id)).toBe(true);
    },
  );

  it('an unauthenticated caller gets 401 on reads and writes', async () => {
    const { reads, writes } = await fixtures();
    for (const ep of [...reads, ...writes]) {
      const res = await send(ep);
      expect(res.status, `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
    }
  });

  it('a role change to CASHIER takes away write access on the next request', async () => {
    const { user, auth } = await authAs('PHARMACIST');
    await request(app)
      .post('/api/categories')
      .set('Authorization', auth)
      .send({ name: 'Syrups' })
      .expect(201);

    await prisma.user.update({
      where: { id: user.id },
      data: { role: { connect: { code: 'CASHIER' } } },
    });

    await request(app)
      .post('/api/categories')
      .set('Authorization', auth)
      .send({ name: 'Drops' })
      .expect(403);
  });
});

describe('no hard deletes', () => {
  it('DELETE is not routed for medicines, categories or suppliers', async () => {
    const { auth } = await authAs('ADMIN');
    const { category, supplier, medicine } = await fixtures();

    for (const path of [
      `/api/categories/${category.id}`,
      `/api/suppliers/${supplier.id}`,
      `/api/medicines/${medicine.id}`,
    ]) {
      const res = await request(app).delete(path).set('Authorization', auth);
      expect(res.status, `DELETE ${path}`).toBe(404);
    }
    expect(await prisma.category.count()).toBe(1);
    expect(await prisma.supplier.count()).toBe(1);
    expect(await prisma.medicine.count()).toBe(1);
  });
});
