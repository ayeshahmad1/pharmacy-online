import { randomUUID } from 'node:crypto';
import type { OfflineCatalogueDto, OfflineSaleConflictDto, Paginated } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import {
  app,
  auditEntries,
  authAs,
  createMedicine,
  daysFromToday,
  ledgerQuantity,
  resetDatabase,
} from './helpers';
import { cash, saleOf, salesSetup, sell } from './sales-fixtures';

beforeEach(resetDatabase);

const DAY_MS = 24 * 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

/** Noon of the business day `days` from today, comfortably inside that day. */
function noonOf(days: number) {
  const date = daysFromToday(days);
  // Asia/Karachi is UTC+5 all year: 12:00 there is 07:00 UTC.
  return new Date(`${date}T07:00:00.000Z`).toISOString();
}

const receiptFor = (date: string, n: number) =>
  `S-${date.replace(/-/g, '')}-${String(n).padStart(4, '0')}`;

type Body = {
  idempotencyKey: string;
  items: { medicineId: string; quantity: number; discount?: object }[];
  payments: object[];
  offline?: { soldAt: string; expectedTotal: string };
  [k: string]: unknown;
};

function offlineBody(
  items: Body['items'],
  expectedTotal: string,
  opts: { soldAt?: string; payments?: object[] } = {},
): Body {
  return {
    idempotencyKey: randomUUID(),
    items,
    payments: opts.payments ?? [cash(expectedTotal)],
    offline: { soldAt: opts.soldAt ?? hoursAgo(1), expectedTotal },
  };
}

function report(
  auth: string,
  sale: Body,
  error = { code: 'INSUFFICIENT_STOCK', message: 'Short' },
) {
  return request(app)
    .post('/api/offline-sales/conflicts')
    .set('Authorization', auth)
    .send({ sale, error });
}

const conflictOf = (res: request.Response) =>
  (res.body as { conflict: OfflineSaleConflictDto }).conflict;

const retry = (auth: string, id: string, body: object = {}) =>
  request(app)
    .post(`/api/offline-sales/conflicts/${id}/retry`)
    .set('Authorization', auth)
    .send(body);

const dismiss = (auth: string, id: string, reason = 'Recorded by hand in the ledger') =>
  request(app)
    .post(`/api/offline-sales/conflicts/${id}/dismiss`)
    .set('Authorization', auth)
    .send({ reason });

describe('GET /api/ping', () => {
  it('answers without a session so the counter can tell it is back online', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /api/inventory/offline-catalogue', () => {
  it('lists active medicines with every batch that has stock, earliest expiry first', async () => {
    const ctx = await salesSetup();
    const panadol = await ctx.medicine('Panadol 500mg', '12.50');
    const late = await ctx.batch(panadol.id, 200, 5, 'LATE');
    const early = await ctx.batch(panadol.id, 20, 3, 'EARLY');
    const expired = await ctx.batch(panadol.id, -5, 2, 'OLD');
    // Sold out: listed nowhere.
    const empty = await ctx.batch(panadol.id, 50, 4, 'EMPTY');
    await prisma.stockMovement.create({
      data: {
        batchId: empty.id,
        type: 'ADJUSTMENT',
        quantity: -4,
        reason: 'Count',
        userId: ctx.pharmacist.user.id,
      },
    });
    const inactive = await createMedicine({
      name: 'Retired',
      categoryId: ctx.category.id,
      status: 'INACTIVE',
    });
    await ctx.batch(inactive.id, 100, 9);
    const noStock = await ctx.medicine('Brufen 400mg');

    const res = await request(app)
      .get('/api/inventory/offline-catalogue')
      .set('Authorization', ctx.cashier.auth);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as OfflineCatalogueDto;
    expect(body).toMatchObject({
      businessDate: businessToday(),
      timeZone: 'Asia/Karachi',
      cashierMaxDiscountPercent: 10,
      offlineSaleMaxAgeDays: 7,
    });
    expect(body.medicines.map((m) => m.id)).toEqual([noStock.id, panadol.id]);
    const p = body.medicines.find((m) => m.id === panadol.id)!;
    expect(p).toMatchObject({ sellingPrice: '12.50', unit: 'tablet', barcode: null });
    expect(p.batches.map((b) => [b.id, b.quantity])).toEqual([
      [expired.id, 2],
      [early.id, 3],
      [late.id, 5],
    ]);
    expect(p.batches[0]).toEqual({
      id: expired.id,
      batchNumber: 'OLD',
      expiryDate: daysFromToday(-5),
      quantity: 2,
    });
    // Cost prices never leave the server through billing.
    expect(JSON.stringify(body)).not.toContain('costPrice');
  });

  it('counts sales against batch stock', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    await sell(ctx.cashier.auth, {
      items: [{ medicineId: m.id, quantity: 4 }],
      payments: [cash('40')],
    });

    const res = await request(app)
      .get('/api/inventory/offline-catalogue')
      .set('Authorization', ctx.cashier.auth);
    expect((res.body as OfflineCatalogueDto).medicines[0]!.batches[0]!.quantity).toBe(6);
  });

  it('requires a signed-in user', async () => {
    expect((await request(app).get('/api/inventory/offline-catalogue')).status).toBe(401);
  });
});

describe('offline sales', () => {
  it('keeps the counter time and joins that day’s receipt series', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    // Today's first online sale takes today's 0001.
    await sell(ctx.cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
    });

    const soldAt = noonOf(-1);
    const res = await sell(
      ctx.cashier.auth,
      offlineBody([{ medicineId: m.id, quantity: 2 }], '20.00', { soldAt }),
    );

    expect(res.status).toBe(201);
    const sale = saleOf(res);
    expect(sale.soldAt).toBe(soldAt);
    expect(sale.receiptNumber).toBe(receiptFor(daysFromToday(-1), 1));
    const audit = await auditEntries('SALE_CREATE');
    expect(audit[1]!.after).toMatchObject({ offline: { soldAt, expectedTotal: '20.00' } });
  });

  it('checks expiry on the day the sale was made', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    // Expired from today onward, so sellable yesterday.
    const b = await ctx.batch(m.id, 0, 5);

    const yesterday = await sell(
      ctx.cashier.auth,
      offlineBody([{ medicineId: m.id, quantity: 2 }], '20.00', { soldAt: noonOf(-1) }),
    );
    expect(yesterday.status).toBe(201);
    expect(await ledgerQuantity(b.id)).toBe(3);

    const today = await sell(
      ctx.cashier.auth,
      offlineBody([{ medicineId: m.id, quantity: 1 }], '10.00', { soldAt: hoursAgo(0) }),
    );
    expect(today.status).toBe(409);
    expect(today.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('refuses a sale that would total differently from what the customer paid', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg', '12.00');
    const b = await ctx.batch(m.id, 30, 10);

    const res = await sell(
      ctx.cashier.auth,
      offlineBody([{ medicineId: m.id, quantity: 2 }], '20.00'),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'PRICE_CHANGED',
      details: {
        expectedTotal: '20.00',
        total: '24.00',
        items: [{ index: 0, medicineId: m.id, unitPrice: '12.00' }],
      },
    });
    expect(await prisma.sale.count()).toBe(0);
    expect(await ledgerQuantity(b.id)).toBe(10);
  });

  it('refuses times in the future and sales older than the age limit', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    const items = [{ medicineId: m.id, quantity: 1 }];

    const future = await sell(
      ctx.cashier.auth,
      offlineBody(items, '10.00', { soldAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    );
    expect(future.status).toBe(400);
    expect(future.body.error.details).toEqual({ field: 'offline.soldAt' });

    const old = await sell(
      ctx.cashier.auth,
      offlineBody(items, '10.00', { soldAt: new Date(Date.now() - 8 * DAY_MS).toISOString() }),
    );
    expect(old.status).toBe(400);
    expect(old.body.error.message).toMatch(/within 7 days/);

    // A few minutes of clock skew is tolerated.
    const skewed = await sell(
      ctx.cashier.auth,
      offlineBody(items, '10.00', { soldAt: new Date(Date.now() + 60 * 1000).toISOString() }),
    );
    expect(skewed.status).toBe(201);
  });

  it('replays an online attempt whose reply was lost when it arrives again from the queue', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    const b = await ctx.batch(m.id, 30, 10);
    const online = {
      idempotencyKey: randomUUID(),
      items: [{ medicineId: m.id, quantity: 2 }],
      payments: [cash('20')],
    };
    const first = await sell(ctx.cashier.auth, online);

    const queued = await sell(ctx.cashier.auth, {
      ...online,
      offline: { soldAt: hoursAgo(0), expectedTotal: '20.00' },
    });

    expect(queued.status).toBe(200);
    expect(queued.body.replayed).toBe(true);
    expect(saleOf(queued).id).toBe(saleOf(first).id);
    expect(await ledgerQuantity(b.id)).toBe(8);
  });
});

describe('flagged offline sales', () => {
  async function setup() {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    const b = await ctx.batch(m.id, 30, 1);
    // Two units sold offline while the server only has one.
    const sale = offlineBody([{ medicineId: m.id, quantity: 2 }], '20.00', { soldAt: noonOf(-1) });
    return { ...ctx, m, b, sale };
  }

  it('records a refused sale for review, once', async () => {
    const { cashier, sale } = await setup();
    const error = {
      code: 'INSUFFICIENT_STOCK',
      message: 'Not enough stock',
      details: { items: [] },
    };

    const first = await report(cashier.auth, sale, error);
    expect(first.status).toBe(201);
    expect(conflictOf(first)).toMatchObject({
      idempotencyKey: sale.idempotencyKey,
      status: 'OPEN',
      cashier: { id: cashier.user.id },
      soldAt: sale.offline!.soldAt,
      expectedTotal: '20.00',
      items: [{ name: 'Panadol 500mg', unit: 'tablet', quantity: 2 }],
      error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock', details: { items: [] } },
      attempts: 1,
      sale: null,
    });

    const again = await report(cashier.auth, sale, error);
    expect(again.status).toBe(200);
    expect(conflictOf(again).id).toBe(conflictOf(first).id);
    expect(await prisma.offlineSaleConflict.count()).toBe(1);
    expect(await auditEntries('OFFLINE_SALE_REPORT')).toHaveLength(1);
  });

  it('refuses reports that are not offline sales, or not the reporter’s', async () => {
    const { cashier, pharmacist, sale } = await setup();
    const { offline: _offline, ...online } = sale;
    expect((await report(cashier.auth, online as Body)).status).toBe(400);

    await report(cashier.auth, sale);
    const other = await report(pharmacist.auth, sale);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses to flag a sale that was saved after all', async () => {
    const { cashier, m, sale } = await setup();
    const saved = { ...sale, items: [{ medicineId: m.id, quantity: 1 }], payments: [cash('10')] };
    saved.offline = { ...sale.offline!, expectedTotal: '10.00' };
    const res = await sell(cashier.auth, saved);
    expect(res.status).toBe(201);

    const flagged = await report(cashier.auth, saved);
    expect(flagged.status).toBe(409);
    expect(flagged.body.error.details.sale.receiptNumber).toBe(saleOf(res).receiptNumber);
  });

  it('shows cashiers only their own flagged sales and lets only managers act', async () => {
    const { cashier, pharmacist, sale } = await setup();
    const other = await authAs('CASHIER', 'cashier2');
    const id = conflictOf(await report(cashier.auth, sale)).id;

    const list = (auth: string) =>
      request(app).get('/api/offline-sales/conflicts').set('Authorization', auth);
    expect(((await list(cashier.auth)).body as Paginated<unknown>).total).toBe(1);
    expect(((await list(other.auth)).body as Paginated<unknown>).total).toBe(0);
    expect(((await list(pharmacist.auth)).body as Paginated<unknown>).total).toBe(1);

    const get = (auth: string) =>
      request(app).get(`/api/offline-sales/conflicts/${id}`).set('Authorization', auth);
    expect((await get(cashier.auth)).status).toBe(200);
    expect((await get(other.auth)).status).toBe(404);

    expect((await retry(cashier.auth, id)).status).toBe(403);
    expect((await dismiss(cashier.auth, id)).status).toBe(403);
  });

  it('filters by status', async () => {
    const { cashier, pharmacist, sale, m } = await setup();
    const a = conflictOf(await report(cashier.auth, sale)).id;
    const second = offlineBody([{ medicineId: m.id, quantity: 5 }], '50.00');
    await report(cashier.auth, second);
    await dismiss(pharmacist.auth, a);

    const res = await request(app)
      .get('/api/offline-sales/conflicts')
      .query({ status: 'OPEN' })
      .set('Authorization', pharmacist.auth);
    const items = (res.body as Paginated<OfflineSaleConflictDto>).items;
    expect(items.map((c) => c.idempotencyKey)).toEqual([second.idempotencyKey]);
  });

  it('saves the sale for its cashier and counter time once stock is fixed', async () => {
    const { cashier, pharmacist, m, b, sale, batch } = await setup();
    const id = conflictOf(await report(cashier.auth, sale)).id;
    // The stock count found the missing units: receive them.
    const found = await batch(m.id, 60, 5);

    const res = await retry(pharmacist.auth, id);

    expect(res.status).toBe(200);
    const resolved = conflictOf(res);
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedBy: { id: pharmacist.user.id },
      attempts: 2,
      sale: { receiptNumber: receiptFor(daysFromToday(-1), 1) },
    });
    const saved = await prisma.sale.findUniqueOrThrow({ where: { id: resolved.sale!.id } });
    expect(saved.cashierId).toBe(cashier.user.id);
    expect(saved.soldAt.toISOString()).toBe(sale.offline!.soldAt);
    expect(saved.idempotencyKey).toBe(sale.idempotencyKey);
    // FEFO: the original batch first, then the received one.
    expect(await ledgerQuantity(b.id)).toBe(0);
    expect(await ledgerQuantity(found.id)).toBe(4);

    const [audit] = await auditEntries('OFFLINE_SALE_RETRY');
    expect(audit).toMatchObject({ userId: pharmacist.user.id, entityId: id });
    expect((await auditEntries('SALE_CREATE'))[0]!.after).toMatchObject({
      approvedBy: pharmacist.user.id,
    });

    // Resolved is final.
    expect((await retry(pharmacist.auth, id)).status).toBe(409);
    expect((await dismiss(pharmacist.auth, id)).status).toBe(409);
  });

  it('keeps the sale open with the new reason when it still cannot be saved', async () => {
    const { cashier, pharmacist, b, sale } = await setup();
    const id = conflictOf(await report(cashier.auth, sale)).id;

    const res = await retry(pharmacist.auth, id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    const row = await prisma.offlineSaleConflict.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'OPEN', attempts: 2, errorCode: 'INSUFFICIENT_STOCK' });
    expect(row.errorMessage).toMatch(/Not enough stock of Panadol/);
    expect(await prisma.sale.count()).toBe(0);
    expect(await ledgerQuantity(b.id)).toBe(1);
  });

  it('lets a manager approve a cashier discount over the cap', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    const sale = offlineBody(
      [{ medicineId: m.id, quantity: 10, discount: { type: 'PERCENT', value: '20' } }],
      '80.00',
    );
    const synced = await sell(ctx.cashier.auth, sale);
    expect(synced.status).toBe(403);
    const id = conflictOf(
      await report(ctx.cashier.auth, sale, {
        code: 'FORBIDDEN',
        message: synced.body.error.message,
      }),
    ).id;

    const res = await retry(ctx.pharmacist.auth, id);

    expect(res.status).toBe(200);
    const saved = await prisma.sale.findUniqueOrThrow({ where: { id: conflictOf(res).sale!.id } });
    expect(saved.cashierId).toBe(ctx.cashier.user.id);
    expect(saved.grandTotal.toFixed(2)).toBe('80.00');
  });

  it('charges current prices only when the reviewer accepts them', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg', '9.00');
    await ctx.batch(m.id, 30, 10);
    // Charged 10 each offline; the price has since dropped to 9.
    const sale = offlineBody([{ medicineId: m.id, quantity: 2 }], '20.00');
    const id = conflictOf(
      await report(ctx.cashier.auth, sale, { code: 'PRICE_CHANGED', message: 'x' }),
    ).id;

    const strict = await retry(ctx.pharmacist.auth, id);
    expect(strict.status).toBe(409);
    expect(strict.body.error.code).toBe('PRICE_CHANGED');

    const accepted = await retry(ctx.pharmacist.auth, id, { acceptCurrentPrices: true });
    expect(accepted.status).toBe(200);
    const saved = await prisma.sale.findUniqueOrThrow({
      where: { id: conflictOf(accepted).sale!.id },
    });
    expect(saved.grandTotal.toFixed(2)).toBe('18.00');
    expect(saved.changeDue.toFixed(2)).toBe('2.00');
  });

  it('retries sales past the age limit once they were flagged in time', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol 500mg');
    await ctx.batch(m.id, 30, 10);
    const sale = offlineBody([{ medicineId: m.id, quantity: 1 }], '10.00', {
      soldAt: new Date(Date.now() - 9 * DAY_MS).toISOString(),
    });
    const id = conflictOf(await report(ctx.cashier.auth, sale)).id;

    const res = await retry(ctx.pharmacist.auth, id);
    expect(res.status).toBe(200);
    expect(conflictOf(res).status).toBe('RESOLVED');
  });

  it('dismisses with a reason and keeps the record', async () => {
    const { cashier, pharmacist, sale } = await setup();
    const id = conflictOf(await report(cashier.auth, sale)).id;

    const noReason = await request(app)
      .post(`/api/offline-sales/conflicts/${id}/dismiss`)
      .set('Authorization', pharmacist.auth)
      .send({ reason: '' });
    expect(noReason.status).toBe(400);

    const res = await dismiss(pharmacist.auth, id, 'Customer returned the extra strip');
    expect(res.status).toBe(200);
    expect(conflictOf(res)).toMatchObject({
      status: 'DISMISSED',
      dismissReason: 'Customer returned the extra strip',
      resolvedBy: { id: pharmacist.user.id },
      sale: null,
    });
    expect(await auditEntries('OFFLINE_SALE_DISMISS')).toHaveLength(1);
    expect((await retry(pharmacist.auth, id)).status).toBe(409);
    expect(await prisma.offlineSaleConflict.count()).toBe(1);
  });

  it('links an already-saved sale on retry instead of selling twice', async () => {
    const { cashier, pharmacist, m, sale, batch } = await setup();
    const id = conflictOf(await report(cashier.auth, sale)).id;
    await batch(m.id, 60, 5);
    // The device's own sync got through after reporting (e.g. stock arrived first).
    const synced = await sell(cashier.auth, sale);
    expect(synced.status).toBe(201);

    const res = await retry(pharmacist.auth, id);
    expect(res.status).toBe(200);
    expect(conflictOf(res).sale!.id).toBe(saleOf(synced).id);
    expect(await prisma.sale.count()).toBe(1);
  });
});
