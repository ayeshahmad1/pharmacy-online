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
import { report, today, tradingDay } from './reports-fixtures';

beforeEach(resetDatabase);

/** 10:00 in Karachi on that day, well inside its business day. */
const on = (day: string) => new Date(`${day}T05:00:00.000Z`);

async function history() {
  const pharmacist = await authAs('PHARMACIST');
  const category = await createCategory();
  const alQamar = await createSupplier('AL Qamar');
  const ahbab = await createSupplier('Ahbab Pharma');
  const panadol = await createMedicine({
    name: 'Panadol 500mg',
    genericName: 'Paracetamol',
    categoryId: category.id,
  });
  const brufen = await createMedicine({ name: 'Brufen 400mg', categoryId: category.id });
  const batch = (medicineId: string) =>
    createBatch({
      medicineId,
      supplierId: alQamar.id,
      userId: pharmacist.user.id,
      expiryDate: daysFromToday(365),
      quantity: 50,
    });
  return {
    pharmacist,
    alQamar,
    ahbab,
    panadol,
    brufen,
    batchP: await batch(panadol.id),
    batchB: await batch(brufen.id),
  };
}

const get = (auth: string, path: string, query: object = {}) =>
  request(app).get(`/api/legacy/${path}`).query(query).set('Authorization', auth);

describe('old-system history', () => {
  it('is only for pharmacists and admins', async () => {
    const cashier = await authAs('CASHIER');
    const admin = await authAs('ADMIN');
    for (const path of ['purchases', 'returns']) {
      expect((await get(cashier.auth, path)).status).toBe(403);
      expect((await request(app).get(`/api/legacy/${path}`)).status).toBe(401);
      expect((await get(admin.auth, path)).status).toBe(200);
    }
  });

  it('lists deliveries newest first, with the cost per unit, and filters them', async () => {
    const h = await history();
    await prisma.legacyPurchase.createMany({
      data: [
        {
          batchId: h.batchP.id,
          supplierId: h.alQamar.id,
          quantity: 300,
          totalCost: '3550.00',
          purchasedAt: on('2026-05-01'),
        },
        {
          batchId: h.batchP.id,
          supplierId: h.alQamar.id,
          quantity: 40,
          totalCost: null,
          purchasedAt: on('2026-06-01'),
        },
        {
          batchId: h.batchB.id,
          supplierId: h.ahbab.id,
          quantity: 10,
          totalCost: '100.00',
          purchasedAt: on('2026-07-01'),
        },
      ],
    });
    const list = async (query: object = {}) => {
      const res = await get(h.pharmacist.auth, 'purchases', query);
      expect(res.status).toBe(200);
      return res.body as { total: number; items: Record<string, unknown>[] };
    };

    const all = await list();
    expect(all.total).toBe(3);
    expect(all.items.map((p) => p.quantity)).toEqual([10, 40, 300]);
    expect(all.items[2]).toMatchObject({
      medicine: { id: h.panadol.id, name: 'Panadol 500mg', genericName: 'Paracetamol' },
      batch: { id: h.batchP.id, batchNumber: h.batchP.batchNumber },
      supplier: { id: h.alQamar.id, name: 'AL Qamar' },
      totalCost: '3550.00',
      unitCost: '11.83', // 3550 / 300 = 11.8333…
      purchasedAt: on('2026-05-01').toISOString(),
    });
    expect(all.items[1]).toMatchObject({ totalCost: null, unitCost: null });

    const quantities = async (query: object) => (await list(query)).items.map((p) => p.quantity);
    expect(await quantities({ q: 'PARACET' })).toEqual([40, 300]);
    expect(await quantities({ medicineId: h.brufen.id })).toEqual([10]);
    expect(await quantities({ supplierId: h.alQamar.id })).toEqual([40, 300]);
    expect(await quantities({ from: '2026-05-02', to: '2026-06-01' })).toEqual([40]);
    expect(await quantities({ pageSize: 1, page: 3 })).toEqual([300]);

    const backwards = await get(h.pharmacist.auth, 'purchases', {
      from: '2026-07-01',
      to: '2026-05-01',
    });
    expect(backwards.status).toBe(400);
  });

  it('lists returns with their lines, and filters by medicine, cashier and day', async () => {
    const h = await history();
    const oldCashier = await authAs('CASHIER', 'old-cashier');
    await prisma.legacyReturn.create({
      data: {
        cashierId: oldCashier.user.id,
        refundTotal: '360.00',
        returnedAt: on('2026-04-07'),
        items: {
          create: [
            {
              lineNo: 1,
              batchId: h.batchP.id,
              quantity: 1,
              unitPrice: '100.00',
              discount: '10.00',
              lineTotal: '90.00',
            },
            {
              lineNo: 2,
              batchId: h.batchB.id,
              quantity: 2,
              unitPrice: '150.00',
              discount: '30.00',
              lineTotal: '270.00',
            },
          ],
        },
      },
    });
    await prisma.legacyReturn.create({
      data: {
        cashierId: h.pharmacist.user.id,
        refundTotal: '45.00',
        returnedAt: on('2026-04-09'),
        items: {
          create: [
            {
              lineNo: 1,
              batchId: h.batchB.id,
              quantity: 3,
              unitPrice: '15.00',
              lineTotal: '45.00',
            },
          ],
        },
      },
    });

    const res = await get(h.pharmacist.auth, 'returns');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((r: { refundTotal: string }) => r.refundTotal)).toEqual([
      '45.00',
      '360.00',
    ]);
    expect(res.body.items[1]).toMatchObject({
      returnedAt: on('2026-04-07').toISOString(),
      cashier: { id: oldCashier.user.id, username: 'old-cashier' },
      refundTotal: '360.00',
      itemCount: 3,
      items: [
        {
          lineNo: 1,
          medicine: { name: 'Panadol 500mg' },
          batch: { id: h.batchP.id },
          quantity: 1,
          unitPrice: '100.00',
          discount: '10.00',
          lineTotal: '90.00',
        },
        { lineNo: 2, medicine: { name: 'Brufen 400mg' }, quantity: 2, lineTotal: '270.00' },
      ],
    });

    const totals = async (query: object) =>
      (
        (await get(h.pharmacist.auth, 'returns', query)).body as {
          items: { refundTotal: string }[];
        }
      ).items.map((r) => r.refundTotal);
    expect(await totals({ q: 'paracetamol' })).toEqual(['360.00']);
    expect(await totals({ medicineId: h.brufen.id })).toEqual(['45.00', '360.00']);
    expect(await totals({ cashierId: oldCashier.user.id })).toEqual(['360.00']);
    expect(await totals({ from: '2026-04-08' })).toEqual(['45.00']);
    expect(await totals({ to: '2026-04-07' })).toEqual(['360.00']);
  });

  it('never changes stock, reports or the cash closing (rule 15)', async () => {
    const t = await tradingDay();
    const batch = await prisma.batch.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    /** A report's figures, without when it was generated. */
    const figures = async (path: string, query: Record<string, string> = {}) =>
      JSON.parse(
        JSON.stringify(
          (await report(t.pharmacist.auth, path, query)).body,
          (key, value: unknown) => (key === 'generatedAt' ? undefined : value),
        ),
      ) as unknown;
    const snapshot = async () => ({
      sales: await figures('sales', { from: today(), to: today() }),
      medicines: await figures('medicines'),
      closing: await figures('cash-closing'),
      stock: await ledgerQuantity(batch.id),
    });
    const before = await snapshot();

    await prisma.legacyReturn.create({
      data: {
        cashierId: t.cashier.user.id,
        refundTotal: '500.00',
        returnedAt: new Date(),
        items: {
          create: [
            { lineNo: 1, batchId: batch.id, quantity: 20, unitPrice: '25.00', lineTotal: '500.00' },
          ],
        },
      },
    });
    await prisma.legacyPurchase.create({
      data: {
        batchId: batch.id,
        supplierId: batch.supplierId,
        quantity: 100,
        totalCost: '1500.00',
        purchasedAt: new Date(),
      },
    });

    expect(await snapshot()).toEqual(before);
  });
});
