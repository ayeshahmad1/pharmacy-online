import { randomUUID } from 'node:crypto';
import type { ReprintMatchDto } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, auditEntries, authAs, resetDatabase } from './helpers';
import { cash, getSale, idsOf, listSales, saleOf, salesSetup, sell } from './sales-fixtures';

beforeEach(resetDatabase);

function searchReprints(auth: string, q: string) {
  return request(app).get('/api/sales/reprint').set('Authorization', auth).query({ q });
}

function reprint(auth: string, id: string) {
  return request(app).post(`/api/sales/${id}/reprint`).set('Authorization', auth).send();
}

const matchesOf = (res: request.Response) => (res.body as { sales: ReprintMatchDto[] }).sales;

describe('customer name on a sale', () => {
  it('is optional, trimmed, and saved with the sale', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);

    const named = await sell(ctx.cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
      customerName: '  Ali Raza  ',
    });
    const blank = await sell(ctx.cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
      customerName: '   ',
    });
    const none = await sell(ctx.cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
    });

    expect(named.status).toBe(201);
    expect(saleOf(named).customerName).toBe('Ali Raza');
    expect(saleOf(blank).customerName).toBeNull();
    expect(saleOf(none).customerName).toBeNull();
    expect((await getSale(ctx.cashier.auth, saleOf(named).id)).body.sale.customerName).toBe(
      'Ali Raza',
    );
    const [audit] = await auditEntries('SALE_CREATE');
    expect(audit!.after).toMatchObject({ customerName: 'Ali Raza' });
  });

  it('refuses a name longer than 100 characters', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);

    const res = await sell(ctx.cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
      customerName: 'x'.repeat(101),
    });

    expect(res.status).toBe(400);
  });

  it('is part of the idempotency check: the same key with another name is refused', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    const body = {
      idempotencyKey: randomUUID(),
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
      customerName: 'Ali Raza',
    };

    expect((await sell(ctx.cashier.auth, body)).status).toBe(201);
    const replay = await sell(ctx.cashier.auth, body);
    const renamed = await sell(ctx.cashier.auth, { ...body, customerName: 'Sana Ali' });

    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('can be searched for in the sales list, still only within a cashier’s own sales', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    const make = async (auth: string, customerName?: string) =>
      saleOf(
        await sell(auth, {
          items: [{ medicineId: m.id, quantity: 1 }],
          payments: [cash('10')],
          customerName,
        }),
      );
    const mine = await make(ctx.cashier.auth, 'Ali Raza');
    await make(ctx.cashier.auth, 'Sana');
    const theirs = await make(ctx.pharmacist.auth, 'Ali Khan');

    const staff = await listSales(ctx.pharmacist.auth, { q: 'ali' });
    const cashier = await listSales(ctx.cashier.auth, { q: 'ali' });
    const byReceipt = await listSales(ctx.pharmacist.auth, { q: mine.receiptNumber });

    expect(new Set(idsOf(staff))).toEqual(new Set([mine.id, theirs.id]));
    expect(staff.body.items[0].customerName).toBeTruthy();
    expect(idsOf(cashier)).toEqual([mine.id]);
    expect(idsOf(byReceipt)).toEqual([mine.id]);
  });
});

describe('reprinting a receipt', () => {
  /** A sale by the pharmacist, to be reprinted by a cashier who didn't ring it up. */
  async function someoneElsesSale() {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    const sale = saleOf(
      await sell(ctx.pharmacist.auth, {
        items: [{ medicineId: m.id, quantity: 2 }],
        payments: [cash('20')],
        customerName: 'Ali Raza',
      }),
    );
    return { ...ctx, m, sale };
  }

  it('lets a cashier find any sale by receipt number or customer name', async () => {
    const { cashier, sale } = await someoneElsesSale();

    const byName = await searchReprints(cashier.auth, 'raza');
    const byReceipt = await searchReprints(cashier.auth, sale.receiptNumber.slice(-6));

    expect(byName.status).toBe(200);
    expect(matchesOf(byName)).toEqual([
      {
        id: sale.id,
        receiptNumber: sale.receiptNumber,
        status: 'COMPLETED',
        soldAt: sale.soldAt,
        cashier: sale.cashier,
        customerName: 'Ali Raza',
        grandTotal: '20.00',
      },
    ]);
    expect(matchesOf(byReceipt).map((s) => s.id)).toEqual([sale.id]);
  });

  it('needs at least 3 characters and returns at most 10 matches, newest first', async () => {
    const { cashier, pharmacist, m, batch } = await someoneElsesSale();
    await batch(m.id, 60, 20);
    for (let i = 0; i < 11; i++) {
      const res = await sell(pharmacist.auth, {
        items: [{ medicineId: m.id, quantity: 1 }],
        payments: [cash('10')],
        customerName: `Ahmed ${i}`,
      });
      expect(res.status).toBe(201);
    }

    const short = await searchReprints(cashier.auth, 'ah');
    const res = await searchReprints(cashier.auth, 'ahmed');

    expect(short.status).toBe(400);
    expect(matchesOf(res)).toHaveLength(10);
    const times = matchesOf(res).map((s) => s.soldAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('gives a cashier the full receipt of any sale and records the reprint', async () => {
    const { cashier, sale } = await someoneElsesSale();
    // The cashier still can't open it as one of their own sales...
    expect((await getSale(cashier.auth, sale.id)).status).toBe(404);

    // ...but can reprint it.
    const res = await reprint(cashier.auth, sale.id);

    expect(res.status).toBe(200);
    expect(saleOf(res)).toEqual(sale);
    const audits = await auditEntries('SALE_REPRINT');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: cashier.user.id,
      entityType: 'Sale',
      entityId: sale.id,
      after: { receiptNumber: sale.receiptNumber, status: 'COMPLETED' },
    });
  });

  it('answers 404 for a sale that does not exist, and 401 without a session', async () => {
    const cashier = await authAs('CASHIER');

    expect((await reprint(cashier.auth, randomUUID())).status).toBe(404);
    expect((await request(app).post(`/api/sales/${randomUUID()}/reprint`)).status).toBe(401);
    expect((await request(app).get('/api/sales/reprint').query({ q: 'abc' })).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'SALE_REPRINT' } })).toBe(0);
  });
});
