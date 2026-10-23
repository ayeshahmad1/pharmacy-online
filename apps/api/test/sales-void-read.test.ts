import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, businessToday, startOfBusinessDay } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { auditEntries, authAs, ledgerQuantity, resetDatabase } from './helpers';
import {
  card,
  cash,
  getSale,
  idsOf,
  listSales,
  saleOf,
  salesSetup,
  sell,
  voidSale,
} from './sales-fixtures';

beforeEach(resetDatabase);

/** A completed sale of 10 units spread over two batches (3 + 7). */
async function soldAcrossTwoBatches() {
  const ctx = await salesSetup();
  const m = await ctx.medicine('Augmentin 625mg', '25.00');
  const b1 = await ctx.batch(m.id, 30, 3, 'A');
  const b2 = await ctx.batch(m.id, 90, 20, 'B');
  const res = await sell(ctx.cashier.auth, {
    items: [{ medicineId: m.id, quantity: 10 }],
    payments: [cash('250')],
  });
  expect(res.status).toBe(201);
  return { ...ctx, m, b1, b2, sale: saleOf(res) };
}

describe('POST /api/sales/:id/void', () => {
  it('restores stock to the original batches with RETURN movements', async () => {
    const { pharmacist, b1, b2, sale } = await soldAcrossTwoBatches();
    expect(await ledgerQuantity(b1.id)).toBe(0);
    expect(await ledgerQuantity(b2.id)).toBe(13);

    const res = await voidSale(pharmacist.auth, sale.id, 'Wrong medicine scanned');

    expect(res.status).toBe(200);
    expect(res.body.sale).toMatchObject({
      id: sale.id,
      status: 'VOIDED',
      voidReason: 'Wrong medicine scanned',
      voidedBy: { id: pharmacist.user.id },
    });
    expect(res.body.sale.voidedAt).toBeTruthy();
    expect(await ledgerQuantity(b1.id)).toBe(3);
    expect(await ledgerQuantity(b2.id)).toBe(20);

    const returns = await prisma.stockMovement.findMany({
      where: { type: 'RETURN' },
      orderBy: { quantity: 'asc' },
    });
    expect(returns).toHaveLength(2);
    expect(returns.map((r) => [r.batchId, r.quantity])).toEqual([
      [b1.id, 3],
      [b2.id, 7],
    ]);
    for (const r of returns) {
      expect(r.userId).toBe(pharmacist.user.id);
      expect(r.saleItemId).toBeTruthy();
      expect(r.reason).toBe(`Void of sale ${sale.receiptNumber}: Wrong medicine scanned`);
    }
  });

  it('keeps the sale, its lines, payments and SALE movements (nothing is deleted)', async () => {
    const { pharmacist, sale } = await soldAcrossTwoBatches();
    await voidSale(pharmacist.auth, sale.id);

    expect(await prisma.sale.count()).toBe(1);
    expect(await prisma.saleItem.count()).toBe(2);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.stockMovement.count({ where: { type: 'SALE' } })).toBe(2);
    // Totals stay as they were, for the audit trail.
    const stored = await getSale(pharmacist.auth, sale.id);
    expect(stored.body.sale).toMatchObject({ grandTotal: '250.00', items: sale.items });
  });

  it('records SALE_VOID in the audit log', async () => {
    const { pharmacist, b1, b2, sale } = await soldAcrossTwoBatches();
    await voidSale(pharmacist.auth, sale.id, 'Customer left');

    const [entry] = await auditEntries('SALE_VOID');
    expect(entry).toMatchObject({
      userId: pharmacist.user.id,
      entityType: 'Sale',
      entityId: sale.id,
      before: { status: 'COMPLETED' },
      after: {
        status: 'VOIDED',
        reason: 'Customer left',
        restocked: [
          { batchId: b1.id, quantity: 3 },
          { batchId: b2.id, quantity: 7 },
        ],
      },
    });
  });

  it('lets an admin void too', async () => {
    const { sale } = await soldAcrossTwoBatches();
    const admin = await authAs('ADMIN');
    expect((await voidSale(admin.auth, sale.id)).status).toBe(200);
  });

  it('is forbidden for cashiers, even for their own sale', async () => {
    const { cashier, b2, sale } = await soldAcrossTwoBatches();

    const res = await voidSale(cashier.auth, sale.id);

    expect(res.status).toBe(403);
    expect(await ledgerQuantity(b2.id)).toBe(13);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe(
      'COMPLETED',
    );
  });

  it('rejects voiding twice and restores stock only once', async () => {
    const { pharmacist, b2, sale } = await soldAcrossTwoBatches();
    await voidSale(pharmacist.auth, sale.id);

    const again = await voidSale(pharmacist.auth, sale.id);

    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(`Sale ${sale.receiptNumber} is already voided`);
    expect(await ledgerQuantity(b2.id)).toBe(20);
    expect(await prisma.stockMovement.count({ where: { type: 'RETURN' } })).toBe(2);
    expect(await auditEntries('SALE_VOID')).toHaveLength(1);
  });

  it('two concurrent voids restore stock only once', async () => {
    const { pharmacist, b1, b2, sale } = await soldAcrossTwoBatches();
    const admin = await authAs('ADMIN');

    const responses = await Promise.all([
      voidSale(pharmacist.auth, sale.id),
      voidSale(admin.auth, sale.id),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ledgerQuantity(b1.id)).toBe(3);
    expect(await ledgerQuantity(b2.id)).toBe(20);
  });

  it('refuses once anything has been returned against the sale', async () => {
    const { pharmacist, b2, sale } = await soldAcrossTwoBatches();
    // Returns arrive in a later session; insert one directly.
    await prisma.return.create({
      data: {
        returnNumber: 'R-TEST-0001',
        saleId: sale.id,
        processedById: pharmacist.user.id,
        reason: 'Allergic reaction',
        refundTotal: '25.00',
        refundMethod: 'CASH',
        items: { create: { saleItemId: sale.items[1]!.id, quantity: 1, refundAmount: '25.00' } },
      },
    });

    const res = await voidSale(pharmacist.auth, sale.id);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/use returns instead/);
    expect(await ledgerQuantity(b2.id)).toBe(13);
  });

  it('requires a reason', async () => {
    const { pharmacist, sale } = await soldAcrossTwoBatches();
    const res = await voidSale(pharmacist.auth, sale.id, ' ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown sale', async () => {
    const { pharmacist } = await salesSetup();
    const res = await voidSale(pharmacist.auth, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('makes the restored units sellable again', async () => {
    const { pharmacist, cashier, m, b1, sale } = await soldAcrossTwoBatches();
    await voidSale(pharmacist.auth, sale.id);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2 }],
      payments: [cash('50')],
    });

    expect(res.status).toBe(201);
    // FEFO: the earliest batch has its 3 units back.
    expect(res.body.sale.items[0].batch.id).toBe(b1.id);
  });
});

describe('GET /api/sales/:id', () => {
  it('returns the full sale without purchase prices', async () => {
    const { pharmacist, b1, sale } = await soldAcrossTwoBatches();

    const res = await getSale(pharmacist.auth, sale.id);

    expect(res.status).toBe(200);
    expect(res.body.sale).toMatchObject({
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      status: 'COMPLETED',
      grandTotal: '250.00',
      items: [
        {
          batch: {
            id: b1.id,
            batchNumber: 'A',
            expiryDate: b1.expiryDate.toISOString().slice(0, 10),
          },
          quantity: 3,
        },
        { quantity: 7 },
      ],
      payments: [{ method: 'CASH', amount: '250.00' }],
      voidedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/costPrice|requestHash/);
  });

  it('lets a cashier read their own sale but not another cashier’s', async () => {
    const { cashier, sale } = await soldAcrossTwoBatches();
    const other = await authAs('CASHIER', 'cashier2');

    expect((await getSale(cashier.auth, sale.id)).status).toBe(200);
    const res = await getSale(other.auth, sale.id);
    expect(res.status).toBe(404);
    expect(res.body.sale).toBeUndefined();
  });

  it('lets managers read any sale', async () => {
    const { pharmacist, sale } = await soldAcrossTwoBatches();
    const admin = await authAs('ADMIN');
    expect((await getSale(pharmacist.auth, sale.id)).status).toBe(200);
    expect((await getSale(admin.auth, sale.id)).status).toBe(200);
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const { pharmacist } = await salesSetup();
    expect((await getSale(pharmacist.auth, '00000000-0000-4000-8000-000000000000')).status).toBe(
      404,
    );
    expect((await getSale(pharmacist.auth, 'abc')).status).toBe(400);
  });
});

describe('GET /api/sales', () => {
  /** Three sales: two by the cashier (one voided), one by the pharmacist. */
  async function threeSales() {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 100);
    const make = async (auth: string, quantity: number, payments: object[]) =>
      saleOf(await sell(auth, { items: [{ medicineId: m.id, quantity }], payments }));

    const s1 = await make(ctx.cashier.auth, 1, [cash('10')]);
    const s2 = await make(ctx.cashier.auth, 2, [card('10'), cash('10')]);
    const s3 = await make(ctx.pharmacist.auth, 3, [card('30')]);
    await voidSale(ctx.pharmacist.auth, s2.id);
    // Pin distinct times so "newest first" doesn't depend on clock resolution.
    const base = Date.now();
    for (const [i, s] of [s1, s2, s3].entries()) {
      await prisma.sale.update({
        where: { id: s.id },
        data: { soldAt: new Date(base - (3 - i) * 60_000) },
      });
    }
    return { ...ctx, s1, s2, s3 };
  }

  it('lists newest first with summaries', async () => {
    const { pharmacist, cashier, s1, s2, s3 } = await threeSales();

    const res = await listSales(pharmacist.auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expect(idsOf(res)).toEqual([s3.id, s2.id, s1.id]);
    expect(res.body.items[1]).toMatchObject({
      receiptNumber: s2.receiptNumber,
      status: 'VOIDED',
      cashier: { id: cashier.user.id },
      grandTotal: '20.00',
      itemCount: 2,
      paymentMethods: ['CASH', 'CARD'],
    });
  });

  it('shows cashiers only their own sales, whatever filter they send', async () => {
    const { cashier, pharmacist, s1, s2 } = await threeSales();

    const own = await listSales(cashier.auth);
    expect(idsOf(own)).toEqual([s2.id, s1.id]);

    const sneaky = await listSales(cashier.auth, { cashierId: pharmacist.user.id });
    expect(idsOf(sneaky)).toEqual([s2.id, s1.id]);
  });

  it('lets managers filter by cashier, status and receipt number', async () => {
    const { pharmacist, cashier, s1, s2, s3 } = await threeSales();

    const byCashier = await listSales(pharmacist.auth, { cashierId: cashier.user.id });
    expect(idsOf(byCashier)).toEqual([s2.id, s1.id]);

    const voided = await listSales(pharmacist.auth, { status: 'VOIDED' });
    expect(idsOf(voided)).toEqual([s2.id]);

    const byReceipt = await listSales(pharmacist.auth, { q: s3.receiptNumber.toLowerCase() });
    expect(idsOf(byReceipt)).toEqual([s3.id]);

    const partial = await listSales(pharmacist.auth, { q: s1.receiptNumber.slice(-4) });
    expect(idsOf(partial)).toEqual([s1.id]);
  });

  it('filters by business day in the pharmacy timezone', async () => {
    const { pharmacist, s1, s2, s3 } = await threeSales();
    const today = businessToday();
    const yesterday = addDays(today, -1);
    // s1 was rung up one minute before midnight yesterday, local time.
    await prisma.sale.update({
      where: { id: s1.id },
      data: { soldAt: new Date(startOfBusinessDay(today).getTime() - 60_000) },
    });

    const todays = await listSales(pharmacist.auth, { from: today, to: today });
    expect(idsOf(todays)).toEqual([s3.id, s2.id]);

    const yesterdays = await listSales(pharmacist.auth, { from: yesterday, to: yesterday });
    expect(idsOf(yesterdays)).toEqual([s1.id]);

    const both = await listSales(pharmacist.auth, { from: yesterday });
    expect(both.body.total).toBe(3);
  });

  it('paginates', async () => {
    const { pharmacist, s2 } = await threeSales();
    const res = await listSales(pharmacist.auth, { page: 2, pageSize: 1 });
    expect(res.body).toMatchObject({ total: 3, page: 2, pageSize: 1 });
    expect(idsOf(res)).toEqual([s2.id]);
  });

  it('rejects a date range that ends before it starts', async () => {
    const { pharmacist } = await salesSetup();
    const res = await listSales(pharmacist.auth, { from: '2026-10-23', to: '2026-10-22' });
    expect(res.status).toBe(400);
  });
});
