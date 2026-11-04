import type { RoleCode } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  authAs,
  createBatch,
  createCategory,
  createMedicine,
  createSupplier,
  daysFromToday,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

type Endpoint = { method: 'get' | 'post'; path: string; body?: object };

async function fixtures() {
  const { user } = await authAs('ADMIN', 'owner');
  const category = await createCategory();
  const supplier = await createSupplier();
  const medicine = await createMedicine({ name: 'Panadol', categoryId: category.id });
  const batch = await createBatch({
    medicineId: medicine.id,
    supplierId: supplier.id,
    userId: user.id,
    expiryDate: daysFromToday(-1),
    quantity: 10,
  });

  // Cashiers need stock levels at the counter.
  const openReads: Endpoint[] = [
    { method: 'get', path: '/api/inventory/stock' },
    { method: 'get', path: `/api/inventory/medicines/${medicine.id}/stock` },
    { method: 'get', path: `/api/inventory/batches/${batch.id}` },
  ];
  const managerReads: Endpoint[] = [
    { method: 'get', path: '/api/inventory/low-stock' },
    { method: 'get', path: '/api/inventory/expiring' },
    { method: 'get', path: '/api/inventory/expired' },
    { method: 'get', path: '/api/inventory/movements' },
  ];
  const writes: Endpoint[] = [
    {
      method: 'post',
      path: '/api/inventory/receipts',
      body: {
        supplierId: supplier.id,
        items: [
          {
            medicineId: medicine.id,
            batchNumber: 'P1',
            expiryDate: daysFromToday(100),
            costPrice: '1.00',
            quantity: 5,
          },
        ],
      },
    },
    {
      method: 'post',
      path: '/api/inventory/adjustments',
      body: { batchId: batch.id, quantity: 1, reason: 'Recount' },
    },
    { method: 'post', path: '/api/inventory/write-offs/expired', body: {} },
    {
      method: 'post',
      path: `/api/inventory/batches/${batch.id}/expiry-corrections`,
      body: { expiryDate: daysFromToday(60), reason: 'Date on the pack' },
    },
  ];
  return { openReads, managerReads, writes };
}

const call = (e: Endpoint, auth?: string) => {
  const req = request(app)[e.method](e.path);
  if (auth) req.set('Authorization', auth);
  return e.body ? req.send(e.body) : req;
};

describe('inventory permissions', () => {
  it('requires authentication everywhere', async () => {
    const { openReads, managerReads, writes } = await fixtures();
    for (const e of [...openReads, ...managerReads, ...writes]) {
      expect((await call(e)).status, `${e.method} ${e.path}`).toBe(401);
    }
  });

  it('cashiers can read stock levels but nothing else, and change nothing', async () => {
    const { openReads, managerReads, writes } = await fixtures();
    const { auth } = await authAs('CASHIER');
    const movementsBefore = await prisma.stockMovement.count();

    for (const e of openReads) {
      expect((await call(e, auth)).status, `${e.method} ${e.path}`).toBe(200);
    }
    for (const e of [...managerReads, ...writes]) {
      const res = await call(e, auth);
      expect(res.status, `${e.method} ${e.path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(await prisma.stockMovement.count()).toBe(movementsBefore);
  });

  it.each<RoleCode>(['ADMIN', 'PHARMACIST'])(
    '%s can use every inventory endpoint',
    async (role) => {
      const { openReads, managerReads, writes } = await fixtures();
      const { auth } = await authAs(role, `${role.toLowerCase()}-2`);

      for (const e of [...openReads, ...managerReads]) {
        expect((await call(e, auth)).status, `${e.method} ${e.path}`).toBe(200);
      }
      for (const e of writes) {
        expect((await call(e, auth)).status, `${e.method} ${e.path}`).toBe(201);
      }
    },
  );
});
