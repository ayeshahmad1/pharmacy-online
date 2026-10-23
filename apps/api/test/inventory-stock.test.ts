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
  ledgerQuantity,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

async function setup() {
  const { user, auth } = await authAs('PHARMACIST');
  const category = await createCategory();
  const supplier = await createSupplier();
  const batchOf =
    (medicineId: string) => (expiryInDays: number, quantity: number, batchNumber?: string) =>
      createBatch({
        medicineId,
        supplierId: supplier.id,
        userId: user.id,
        expiryDate: daysFromToday(expiryInDays),
        quantity,
        batchNumber,
      });
  const medicine = async (name: string, reorderLevel = 0, status?: 'ACTIVE' | 'INACTIVE') => {
    const m = await createMedicine({ name, categoryId: category.id, status });
    await prisma.medicine.update({ where: { id: m.id }, data: { reorderLevel } });
    return { ...m, reorderLevel, batch: batchOf(m.id) };
  };
  return { user, auth, category, supplier, medicine };
}

const get = (auth: string, path: string, query: Record<string, string | number> = {}) =>
  request(app).get(path).query(query).set('Authorization', auth);

const adjust = (auth: string, batchId: string, quantity: number) =>
  request(app)
    .post('/api/inventory/adjustments')
    .set('Authorization', auth)
    .send({ batchId, quantity, reason: 'Test adjustment' });

describe('GET /api/inventory/medicines/:id/stock', () => {
  it('splits stock into sellable and expired, batches earliest expiry first', async () => {
    const { auth, medicine } = await setup();
    const panadol = await medicine('Panadol', 50);
    await panadol.batch(200, 100, 'LATE');
    await panadol.batch(-3, 15, 'EXPIRED');
    await panadol.batch(20, 30, 'SOON');

    const res = await get(auth, `/api/inventory/medicines/${panadol.id}/stock`);

    expect(res.status).toBe(200);
    expect(res.body.stock).toMatchObject({
      medicine: { id: panadol.id, name: 'Panadol', reorderLevel: 50 },
      sellableQuantity: 130,
      expiredQuantity: 15,
      totalQuantity: 145,
      isLowStock: false,
      nextExpiry: daysFromToday(20),
    });
    expect(
      res.body.stock.batches.map((b: { batchNumber: string; isExpired: boolean }) => [
        b.batchNumber,
        b.isExpired,
      ]),
    ).toEqual([
      ['EXPIRED', true],
      ['SOON', false],
      ['LATE', false],
    ]);
  });

  it('reflects every kind of movement and hides empty batches unless asked', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine('Brufen');
    const a = await m.batch(100, 10, 'A');
    const b = await m.batch(150, 5, 'B');
    await adjust(auth, a.id, -10);
    await adjust(auth, b.id, 3);

    const res = await get(auth, `/api/inventory/medicines/${m.id}/stock`);
    expect(res.body.stock.sellableQuantity).toBe(8);
    expect(res.body.stock.batches.map((x: { batchNumber: string }) => x.batchNumber)).toEqual([
      'B',
    ]);
    // nextExpiry skips the emptied batch A.
    expect(res.body.stock.nextExpiry).toBe(daysFromToday(150));

    const all = await get(auth, `/api/inventory/medicines/${m.id}/stock`, { includeEmpty: 'true' });
    expect(all.body.stock.batches).toHaveLength(2);
  });

  it('a medicine with no batches has zero stock and is low stock', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine('New item', 0);
    const res = await get(auth, `/api/inventory/medicines/${m.id}/stock`);
    expect(res.body.stock).toMatchObject({
      sellableQuantity: 0,
      expiredQuantity: 0,
      totalQuantity: 0,
      isLowStock: true,
      nextExpiry: null,
      batches: [],
    });
  });

  it('404s for an unknown medicine', async () => {
    const { auth } = await setup();
    const res = await get(
      auth,
      '/api/inventory/medicines/00000000-0000-4000-8000-000000000000/stock',
    );
    expect(res.status).toBe(404);
  });

  it('hides cost prices from cashiers', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine('Panadol');
    const b = await m.batch(100, 10);
    const cashier = (await authAs('CASHIER')).auth;

    const asCashier = await get(cashier, `/api/inventory/medicines/${m.id}/stock`);
    expect(asCashier.status).toBe(200);
    expect(asCashier.body.stock.batches[0].costPrice).toBeNull();
    expect((await get(cashier, `/api/inventory/batches/${b.id}`)).body.batch.costPrice).toBeNull();

    const asPharmacist = await get(auth, `/api/inventory/medicines/${m.id}/stock`);
    expect(asPharmacist.body.stock.batches[0].costPrice).toBe('5.00');
  });
});

describe('GET /api/inventory/batches/:id', () => {
  it('returns the batch with its computed quantity and expiry status', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine('Panadol');
    const b = await m.batch(-1, 9, 'X');
    await adjust(auth, b.id, -4);

    const res = await get(auth, `/api/inventory/batches/${b.id}`);
    expect(res.body.batch).toMatchObject({
      id: b.id,
      batchNumber: 'X',
      quantity: 5,
      quantityReceived: 9,
      isExpired: true,
      daysToExpiry: -1,
    });
  });

  it('404s for an unknown batch', async () => {
    const { auth } = await setup();
    const res = await get(auth, '/api/inventory/batches/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/inventory/stock', () => {
  it('lists every medicine with totals, alphabetically, with search and paging', async () => {
    const { auth, medicine } = await setup();
    const a = await medicine('Augmentin', 10);
    await a.batch(100, 24);
    await a.batch(-1, 6);
    await medicine('Zyrtec', 5);
    const p = await medicine('Panadol', 100);
    await p.batch(50, 40);

    const res = await get(auth, '/api/inventory/stock');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(
      res.body.items.map(
        (i: { medicine: { name: string }; sellableQuantity: number; expiredQuantity: number }) => [
          i.medicine.name,
          i.sellableQuantity,
          i.expiredQuantity,
        ],
      ),
    ).toEqual([
      ['Augmentin', 24, 6],
      ['Panadol', 40, 0],
      ['Zyrtec', 0, 0],
    ]);

    const search = await get(auth, '/api/inventory/stock', { q: 'pana' });
    expect(search.body.items.map((i: { medicine: { name: string } }) => i.medicine.name)).toEqual([
      'Panadol',
    ]);

    const page2 = await get(auth, '/api/inventory/stock', { page: 2, pageSize: 2 });
    expect(page2.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page2.body.items[0].medicine.name).toBe('Zyrtec');
  });

  it('agrees with the per-medicine endpoint', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine('Flagyl', 30);
    await m.batch(10, 7);
    await m.batch(-10, 3);
    await m.batch(90, 22);

    const list = (await get(auth, '/api/inventory/stock')).body.items[0];
    const { batches: _batches, ...single } = (
      await get(auth, `/api/inventory/medicines/${m.id}/stock`)
    ).body.stock;
    expect(list).toEqual(single);
  });
});

describe('GET /api/inventory/low-stock', () => {
  it('lists active medicines at or below their reorder level, out-of-stock first', async () => {
    const { auth, medicine } = await setup();
    const atLevel = await medicine('At level', 20);
    await atLevel.batch(100, 20);
    const above = await medicine('Above level', 20);
    await above.batch(100, 21);
    await medicine('Out of stock', 10);
    const onlyExpired = await medicine('Only expired stock', 5);
    await onlyExpired.batch(-1, 500); // expired stock doesn't count
    const inactive = await medicine('Discontinued', 50, 'INACTIVE');
    await inactive.batch(100, 1);

    const res = await get(auth, '/api/inventory/low-stock');

    expect(res.status).toBe(200);
    expect(
      res.body.items.map((i: { medicine: { name: string }; sellableQuantity: number }) => [
        i.medicine.name,
        i.sellableQuantity,
      ]),
    ).toEqual([
      ['Only expired stock', 0],
      ['Out of stock', 0],
      ['At level', 20],
    ]);
    expect(res.body.total).toBe(3);
    expect(res.body.items.every((i: { isLowStock: boolean }) => i.isLowStock)).toBe(true);
  });

  it('a medicine leaves the list once restocked above its level', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine('Risek', 10);
    const b = await m.batch(100, 5);
    expect((await get(auth, '/api/inventory/low-stock')).body.total).toBe(1);
    await adjust(auth, b.id, 6);
    expect((await get(auth, '/api/inventory/low-stock')).body.total).toBe(0);
  });
});

describe('GET /api/inventory/expiring and /expired', () => {
  async function seed() {
    const s = await setup();
    const m = await s.medicine('Panadol');
    await m.batch(-5, 10, 'EXPIRED');
    await m.batch(0, 4, 'TODAY');
    await m.batch(1, 10, 'D1');
    await m.batch(30, 10, 'D30');
    await m.batch(31, 10, 'D31');
    await m.batch(200, 10, 'D200');
    const empty = await m.batch(10, 2, 'EMPTY');
    await adjust(s.auth, empty.id, -2);
    return s;
  }
  const numbers = (body: unknown) =>
    (body as { items: { batchNumber: string }[] }).items.map((b) => b.batchNumber);

  it('lists unexpired batches with stock expiring within the given days, soonest first', async () => {
    const { auth } = await seed();

    const res = await get(auth, '/api/inventory/expiring', { days: 30 });
    expect(res.status).toBe(200);
    expect(numbers(res.body)).toEqual(['D1', 'D30']);
    expect(res.body).toMatchObject({ days: 30, expiringOnOrBefore: daysFromToday(30), total: 2 });
    expect(res.body.items[0]).toMatchObject({ daysToExpiry: 1, isExpired: false, quantity: 10 });

    expect(numbers((await get(auth, '/api/inventory/expiring', { days: 31 })).body)).toEqual([
      'D1',
      'D30',
      'D31',
    ]);
  });

  it('defaults to EXPIRY_WARNING_DAYS (90)', async () => {
    const { auth } = await seed();
    const res = await get(auth, '/api/inventory/expiring');
    expect(res.body.days).toBe(90);
    expect(numbers(res.body)).toEqual(['D1', 'D30', 'D31']);
  });

  it.each([0, -1, 731, 'abc'])('rejects days=%s', async (days) => {
    const { auth } = await setup();
    const res = await get(auth, '/api/inventory/expiring', { days });
    expect(res.status).toBe(400);
  });

  it('lists expired batches that still have stock', async () => {
    const { auth } = await seed();
    const res = await get(auth, '/api/inventory/expired');
    expect(numbers(res.body)).toEqual(['EXPIRED', 'TODAY']);
    expect(res.body.items.every((b: { isExpired: boolean }) => b.isExpired)).toBe(true);

    await request(app)
      .post('/api/inventory/write-offs/expired')
      .set('Authorization', auth)
      .send({});
    expect((await get(auth, '/api/inventory/expired')).body.total).toBe(0);
  });
});

describe('GET /api/inventory/movements', () => {
  it('lists the ledger newest first, filterable by batch, medicine and type', async () => {
    const { auth, medicine } = await setup();
    const a = await medicine('A');
    const b = await medicine('B');
    const a1 = await a.batch(100, 10);
    const b1 = await b.batch(100, 10);
    await adjust(auth, a1.id, -1);
    await adjust(auth, b1.id, 2);

    const all = await get(auth, '/api/inventory/movements');
    expect(all.body.total).toBe(4);
    expect(all.body.items[0]).toMatchObject({ type: 'ADJUSTMENT', quantity: 2 });

    const byBatch = await get(auth, '/api/inventory/movements', { batchId: a1.id });
    expect(byBatch.body.items.map((m: { quantity: number }) => m.quantity)).toEqual([-1, 10]);

    const byMedicine = await get(auth, '/api/inventory/movements', { medicineId: b.id });
    expect(byMedicine.body.total).toBe(2);
    expect(byMedicine.body.items[0].batch.medicine.name).toBe('B');

    const purchases = await get(auth, '/api/inventory/movements', { type: 'PURCHASE' });
    expect(purchases.body.total).toBe(2);
  });
});

describe('stock always equals the sum of movements', () => {
  // A deterministic pseudo-random walk of receipts, adjustments (some of which
  // must be refused) and write-offs. After every step, the API's numbers must
  // match both an independent model and the raw ledger.
  it('holds across a long sequence of mixed operations', async () => {
    const { auth, medicine, supplier } = await setup();
    const m = await medicine('Walk', 25);
    const expired = await m.batch(-2, 40, 'EXP');
    const model = new Map<string, { qty: number; expired: boolean }>([
      [expired.id, { qty: 40, expired: true }],
    ]);

    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };

    for (let step = 0; step < 40; step++) {
      const op = rand(10);
      const ids = [...model.keys()];
      if (op < 3) {
        const quantity = 1 + rand(50);
        const res = await request(app)
          .post('/api/inventory/receipts')
          .set('Authorization', auth)
          .send({
            supplierId: supplier.id,
            items: [
              {
                medicineId: m.id,
                batchNumber: `W-${step}`,
                expiryDate: daysFromToday(1 + rand(400)),
                costPrice: '3.10',
                quantity,
              },
            ],
          });
        expect(res.status).toBe(201);
        model.set(res.body.batches[0].id as string, { qty: quantity, expired: false });
      } else if (op < 9) {
        const id = ids[rand(ids.length)]!;
        const entry = model.get(id)!;
        const change = rand(2) ? 1 + rand(20) : -(1 + rand(entry.qty + 10));
        const res = await adjust(auth, id, change);
        if (entry.qty + change < 0) {
          expect(res.status).toBe(409);
        } else {
          expect(res.status).toBe(201);
          entry.qty += change;
        }
      } else {
        const res = await request(app)
          .post('/api/inventory/write-offs/expired')
          .set('Authorization', auth)
          .send({});
        expect(res.status).toBe(201);
        for (const entry of model.values()) if (entry.expired) entry.qty = 0;
      }

      const stock = (
        await get(auth, `/api/inventory/medicines/${m.id}/stock`, {
          includeEmpty: 'true',
        })
      ).body.stock;
      let sellable = 0;
      let expiredQty = 0;
      for (const [id, entry] of model) {
        expect(entry.qty).toBeGreaterThanOrEqual(0);
        expect(await ledgerQuantity(id)).toBe(entry.qty);
        const batch = stock.batches.find((b: { id: string }) => b.id === id);
        expect(batch.quantity).toBe(entry.qty);
        if (entry.expired) expiredQty += entry.qty;
        else sellable += entry.qty;
      }
      expect(stock.sellableQuantity).toBe(sellable);
      expect(stock.expiredQuantity).toBe(expiredQty);

      const listed = (await get(auth, '/api/inventory/stock')).body.items[0];
      expect([listed.sellableQuantity, listed.expiredQuantity]).toEqual([sellable, expiredQty]);
    }
  });
});

describe('database guards on the ledger', () => {
  it('rejects a movement that would take a batch below zero, even bypassing the API', async () => {
    const { user, medicine } = await setup();
    const m = await medicine('Guarded');
    const b = await m.batch(100, 5);

    await expect(
      prisma.stockMovement.create({
        data: { batchId: b.id, type: 'ADJUSTMENT', quantity: -6, reason: 'x', userId: user.id },
      }),
    ).rejects.toThrow(/would become negative/);
    expect(await ledgerQuantity(b.id)).toBe(5);

    // Exactly emptying it is fine.
    await prisma.stockMovement.create({
      data: { batchId: b.id, type: 'EXPIRED_WRITEOFF', quantity: -5, userId: user.id },
    });
    expect(await ledgerQuantity(b.id)).toBe(0);
  });

  it('rejects movements whose sign does not match their type', async () => {
    const { user, medicine } = await setup();
    const b = await (await medicine('Signs')).batch(100, 5);
    await expect(
      prisma.stockMovement.create({
        data: { batchId: b.id, type: 'PURCHASE', quantity: -1, userId: user.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.stockMovement.create({
        data: { batchId: b.id, type: 'EXPIRED_WRITEOFF', quantity: 1, userId: user.id },
      }),
    ).rejects.toThrow();
  });

  it('never lets ledger rows be edited or deleted', async () => {
    const { medicine } = await setup();
    const b = await (await medicine('Append only')).batch(100, 5);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { batchId: b.id } });

    await expect(
      prisma.stockMovement.update({ where: { id: movement.id }, data: { quantity: 500 } }),
    ).rejects.toThrow(/cannot be updated or deleted/);
    await expect(prisma.stockMovement.delete({ where: { id: movement.id } })).rejects.toThrow(
      /cannot be updated or deleted/,
    );
    expect(await ledgerQuantity(b.id)).toBe(5);
  });
});
