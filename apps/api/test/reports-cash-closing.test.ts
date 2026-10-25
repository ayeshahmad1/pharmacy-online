import type { CashClosingReportDto } from '@pharmacy/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { toPaisa } from '../src/lib/money';
import { BOM } from '../src/lib/csv';
import { prisma } from '../src/lib/prisma';
import { resetDatabase } from './helpers';
import { moveSale, report, today, tradingDay, yesterday } from './reports-fixtures';
import { cash, saleOf, sell, voidSale } from './sales-fixtures';

beforeEach(resetDatabase);

const closingOf = (res: { body: unknown }) => res.body as CashClosingReportDto;

describe('GET /api/reports/cash-closing', () => {
  it('works out the drawer from sales, voids and refunds', async () => {
    const t = await tradingDay();

    const res = await report(t.pharmacist.auth, 'cash-closing');

    expect(res.status).toBe(200);
    const closing = closingOf(res);
    expect(closing.date).toBe(today());
    // S3 was voided, but its cash came in today and went back today.
    expect(closing.sales).toEqual({
      count: 3,
      byMethod: { CASH: '130.00', CARD: '67.50', MOBILE_WALLET: '0.00' },
      total: '197.50',
      cashTendered: '160.00',
      changeGiven: '30.00',
    });
    expect(closing.voids).toEqual({
      count: 1,
      byMethod: { CASH: '10.00', CARD: '0.00', MOBILE_WALLET: '0.00' },
      total: '10.00',
    });
    expect(closing.refunds).toMatchObject({
      count: 1,
      total: '35.00',
      byMethod: { CASH: '35.00' },
    });
    expect(closing.net).toEqual({ CASH: '85.00', CARD: '67.50', MOBILE_WALLET: '0.00' });
    expect(closing.expectedCash).toBe('85.00');

    // The cashier took the cash; the pharmacist handed back the void and the refund.
    const person = (id: string) => closing.people.find((p) => p.user.id === id)!;
    expect(person(t.cashier.user.id)).toMatchObject({
      expectedCash: '130.00',
      sales: { count: 2 },
    });
    expect(person(t.pharmacist.user.id)).toMatchObject({
      expectedCash: '-45.00',
      net: { CARD: '67.50' },
      voids: { count: 1 },
      refunds: { count: 1 },
    });
  });

  it('counts voids and refunds on the day the money went back, so a closed day never changes', async () => {
    const t = await tradingDay();
    // Yesterday's sale, voided today.
    const late = saleOf(
      await sell(t.cashier.auth, {
        items: [{ medicineId: t.brufen.id, quantity: 5 }],
        payments: [cash('50')],
      }),
    );
    await moveSale(late.id, yesterday());
    const before = closingOf(
      await report(t.pharmacist.auth, 'cash-closing', { date: yesterday() }),
    );
    await voidSale(t.pharmacist.auth, late.id).expect(200);
    // S1 also belongs to yesterday; its return was refunded today.
    await moveSale(t.s1.id, yesterday());

    const yesterdays = closingOf(
      await report(t.pharmacist.auth, 'cash-closing', { date: yesterday() }),
    );
    const todays = closingOf(await report(t.pharmacist.auth, 'cash-closing', { date: today() }));

    expect(yesterdays.sales).toMatchObject({ count: 2, byMethod: { CASH: '170.00' } });
    expect(yesterdays.voids.count).toBe(0);
    expect(yesterdays.refunds.count).toBe(0);
    expect(yesterdays.expectedCash).toBe('170.00');
    // Only S1 moved into yesterday after `before` was taken; the void changed nothing there.
    expect(toPaisa(yesterdays.expectedCash) - toPaisa(before.expectedCash)).toBe(120_00n);

    expect(todays.sales).toMatchObject({ count: 2, byMethod: { CASH: '10.00', CARD: '67.50' } });
    expect(todays.voids).toMatchObject({ count: 2, byMethod: { CASH: '60.00' } });
    expect(todays.refunds).toMatchObject({ count: 1, byMethod: { CASH: '35.00' } });
    expect(todays.expectedCash).toBe('-85.00');
  });

  it('flags money not yet in the figures: pending returns and refused offline sales', async () => {
    const t = await tradingDay();
    await prisma.offlineSaleConflict.create({
      data: {
        idempotencyKey: crypto.randomUUID(),
        cashierId: t.cashier.user.id,
        request: {},
        soldAt: new Date(),
        expectedTotal: '42.00',
        errorCode: 'INSUFFICIENT_STOCK',
        errorMessage: 'Not enough stock',
      },
    });
    const res = await report(t.pharmacist.auth, 'cash-closing');
    expect(closingOf(res).openOfflineConflicts).toEqual({ count: 1, expectedTotal: '42.00' });
    expect(closingOf(res).pendingReturns).toEqual({ count: 0, refundTotal: '0.00' });
  });

  it('exports one row per person and a total', async () => {
    const t = await tradingDay();
    const res = await report(t.pharmacist.auth, 'cash-closing', { format: 'csv' });
    const lines = res.text.replace(BOM, '').trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Person,Username,Sales,Sales cash/);
    expect(lines[3]).toMatch(/^TOTAL,,3,130.00,67.50,0.00,1,10.00,.*,85.00$/);
  });
});
