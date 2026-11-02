import type { DaySalesDto } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, businessToday, startOfBusinessDay } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { app, authAs, resetDatabase } from './helpers';
import { card, cash, saleOf, salesSetup, sell, voidSale, wallet } from './sales-fixtures';

beforeEach(resetDatabase);

function daySales(auth: string, query: Record<string, string> = {}) {
  return request(app).get('/api/sales/day').set('Authorization', auth).query(query);
}
const dayOf = (res: request.Response) => res.body as DaySalesDto;

/** Puts a sale `offsetMs` after the start of a business day. */
const moveTo = (saleId: string, day: string, offsetMs: number) =>
  prisma.sale.update({
    where: { id: saleId },
    data: { soldAt: new Date(startOfBusinessDay(day).getTime() + offsetMs) },
  });

const MINUTE = 60_000;

async function setup() {
  const ctx = await salesSetup();
  const m = await ctx.medicine('Panadol 500mg', '10.00');
  await ctx.batch(m.id, 365, 500);
  const sale = async (auth: string, quantity: number, payments: object[]) => {
    const res = await sell(auth, { items: [{ medicineId: m.id, quantity }], payments });
    expect(res.status).toBe(201);
    return saleOf(res);
  };
  return { ...ctx, m, sale };
}

describe('GET /api/sales/day', () => {
  it('runs midnight to midnight Pakistan time', async () => {
    // Asia/Karachi is UTC+5 all year: the day starts at 19:00 UTC the day before.
    expect(startOfBusinessDay('2026-11-02').toISOString()).toBe('2026-11-01T19:00:00.000Z');

    const t = await setup();
    const today = businessToday();
    const yesterday = addDays(today, -1);
    const lateLastNight = await t.sale(t.cashier.auth, 1, [cash('10')]);
    const atMidnight = await t.sale(t.cashier.auth, 2, [cash('20')]);
    const justBeforeNextMidnight = await t.sale(t.cashier.auth, 3, [cash('30')]);
    // 23:59 yesterday, 00:00 today, 23:59 today.
    await moveTo(lateLastNight.id, today, -1 * MINUTE);
    await moveTo(atMidnight.id, today, 0);
    await moveTo(justBeforeNextMidnight.id, today, 24 * 60 * MINUTE - MINUTE);

    const todays = dayOf(await daySales(t.pharmacist.auth));
    expect(todays.date).toBe(today);
    expect(todays.sales.map((s) => s.id)).toEqual([atMidnight.id, justBeforeNextMidnight.id]);
    expect(todays.totals.grandTotal).toBe('50.00');

    const yesterdays = dayOf(await daySales(t.pharmacist.auth, { date: yesterday }));
    expect(yesterdays.date).toBe(yesterday);
    expect(yesterdays.sales.map((s) => s.id)).toEqual([lateLastNight.id]);
    expect(yesterdays.totals.grandTotal).toBe('10.00');
  });

  it('lists the day oldest first with totals by payment method', async () => {
    const t = await setup();
    const first = await t.sale(t.cashier.auth, 5, [cash('100')]);
    const second = await t.sale(t.pharmacist.auth, 3, [cash('10'), card('20')]);
    const third = await t.sale(t.cashier.auth, 1, [wallet('10')]);

    const res = await daySales(t.pharmacist.auth);

    expect(res.status).toBe(200);
    const day = dayOf(res);
    expect(day.cashier).toBeNull();
    expect(day.sales.map((s) => s.receiptNumber)).toEqual([
      first.receiptNumber,
      second.receiptNumber,
      third.receiptNumber,
    ]);
    expect(day.sales[0]).toMatchObject({ grandTotal: '50.00', itemCount: 5, changeDue: '50.00' });
    expect(day.totals).toEqual({
      saleCount: 3,
      itemCount: 9,
      discountTotal: '0.00',
      grandTotal: '90.00',
      // Cash is what was kept, not what was handed over.
      byMethod: { CASH: '60.00', CARD: '20.00', MOBILE_WALLET: '10.00' },
      voidedCount: 0,
      voidedTotal: '0.00',
    });
  });

  it('lists voided sales but leaves them out of the totals', async () => {
    const t = await setup();
    await t.sale(t.cashier.auth, 2, [cash('20')]);
    const voided = await t.sale(t.cashier.auth, 4, [card('40')]);
    expect((await voidSale(t.pharmacist.auth, voided.id)).status).toBe(200);

    const day = dayOf(await daySales(t.pharmacist.auth));

    expect(day.sales.map((s) => s.status)).toEqual(['COMPLETED', 'VOIDED']);
    expect(day.totals).toMatchObject({
      saleCount: 1,
      itemCount: 2,
      grandTotal: '20.00',
      byMethod: { CASH: '20.00', CARD: '0.00', MOBILE_WALLET: '0.00' },
      voidedCount: 1,
      voidedTotal: '40.00',
    });
  });

  it("gives a cashier only their own sales; managers see everyone's", async () => {
    const t = await setup();
    const other = await authAs('CASHIER', 'cashier2');
    const mine = await t.sale(t.cashier.auth, 1, [cash('10')]);
    await t.sale(other.auth, 2, [cash('20')]);
    await t.sale(t.pharmacist.auth, 3, [cash('30')]);

    const own = dayOf(await daySales(t.cashier.auth));
    expect(own.cashier).toEqual({
      id: t.cashier.user.id,
      username: t.cashier.user.username,
      fullName: t.cashier.user.fullName,
    });
    expect(own.sales.map((s) => s.id)).toEqual([mine.id]);
    expect(own.totals.grandTotal).toBe('10.00');

    const admin = await authAs('ADMIN');
    const all = dayOf(await daySales(admin.auth));
    expect(all.cashier).toBeNull();
    expect(all.sales).toHaveLength(3);
    expect(all.totals.grandTotal).toBe('60.00');
  });

  it('is empty, with zero totals, on a day with no sales', async () => {
    const t = await setup();
    const day = dayOf(await daySales(t.cashier.auth));
    expect(day.sales).toEqual([]);
    expect(day.totals).toMatchObject({ saleCount: 0, grandTotal: '0.00' });
  });

  it('rejects a malformed date and an unauthenticated request', async () => {
    const t = await setup();
    const bad = await daySales(t.pharmacist.auth, { date: '02-11-2026' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get('/api/sales/day')).status).toBe(401);
  });
});
