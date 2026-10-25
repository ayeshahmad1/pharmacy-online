import type {
  CashierReportDto,
  MedicineReportDto,
  SalesMetricsDto,
  SalesReportDto,
} from '@pharmacy/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates';
import { formatPaisa, toPaisa } from '../src/lib/money';
import { BOM } from '../src/lib/csv';
import { prisma } from '../src/lib/prisma';
import { authAs, resetDatabase } from './helpers';
import { moveSale, report, today, tradingDay, yesterday } from './reports-fixtures';

beforeEach(resetDatabase);

const salesOf = (res: { body: unknown }) => res.body as SalesReportDto;

/** Sales report totals computed straight from the tables, independently of the report SQL. */
async function rawTotals(): Promise<Partial<SalesMetricsDto>> {
  const counted = { status: { in: ['COMPLETED' as const, 'REFUNDED' as const] } };
  const sales = await prisma.sale.aggregate({
    where: counted,
    _count: true,
    _sum: { subtotal: true, discountTotal: true, grandTotal: true },
  });
  const returns = await prisma.returnItem.findMany({
    where: { return: { status: 'COMPLETED', sale: counted } },
    include: { saleItem: { include: { batch: true } } },
  });
  const lines = await prisma.saleItem.findMany({
    where: { sale: counted },
    include: { batch: true },
  });
  const soldCost = lines.reduce((n, l) => n + toPaisa(l.batch.costPrice) * BigInt(l.quantity), 0n);
  const restocked = returns
    .filter((r) => r.restock)
    .reduce((n, r) => n + toPaisa(r.saleItem.batch.costPrice) * BigInt(r.quantity), 0n);
  const refunds = returns.reduce((n, r) => n + toPaisa(r.refundAmount), 0n);
  const net = toPaisa(sales._sum.grandTotal!);
  return {
    saleCount: sales._count,
    grossSales: sales._sum.subtotal!.toFixed(2),
    discounts: sales._sum.discountTotal!.toFixed(2),
    netSales: formatPaisa(net),
    refunds: formatPaisa(refunds),
    revenue: formatPaisa(net - refunds),
    cost: formatPaisa(soldCost - restocked),
    grossProfit: formatPaisa(net - refunds - (soldCost - restocked)),
  };
}

describe('GET /api/reports/sales', () => {
  it('matches the raw sales data and the worked example', async () => {
    const t = await tradingDay();

    const res = await report(t.pharmacist.auth, 'sales', { from: today(), to: today() });

    expect(res.status).toBe(200);
    const { totals, periods } = salesOf(res);
    expect(totals).toEqual({
      saleCount: 2, // S3 was voided
      grossSales: '195.00',
      discounts: '7.50',
      netSales: '187.50',
      refunds: '35.00',
      revenue: '152.50',
      cost: '98.00', // 7×15 + 2×4 sold, less the 15.00 Augmentin back on the shelf
      grossProfit: '54.50',
      marginPercent: '35.74',
      averageBill: '93.75',
    });
    expect(totals).toMatchObject(await rawTotals());
    expect(periods).toEqual([{ period: today(), ...totals }]);
  });

  it('fills empty days and takes a refund off the day of the original sale', async () => {
    const t = await tradingDay();
    // S1 (and so its return) belongs to yesterday; the refund still happened today.
    await moveSale(t.s1.id, yesterday());

    const res = await report(t.pharmacist.auth, 'sales', {
      from: addDays(today(), -2),
      to: today(),
    });

    const periods = salesOf(res).periods;
    expect(periods.map((p) => p.period)).toEqual([addDays(today(), -2), yesterday(), today()]);
    expect(periods[0]).toMatchObject({ saleCount: 0, revenue: '0.00', marginPercent: null });
    expect(periods[1]).toMatchObject({
      saleCount: 1,
      netSales: '120.00',
      refunds: '35.00',
      revenue: '85.00',
    });
    expect(periods[2]).toMatchObject({ saleCount: 1, netSales: '67.50', refunds: '0.00' });
    expect(salesOf(res).totals).toMatchObject(await rawTotals());
  });

  it('groups by week and month', async () => {
    const t = await tradingDay();
    const lastMonth = addDays(`${today().slice(0, 7)}-01`, -1);
    await moveSale(t.s2.id, lastMonth);

    const res = await report(t.pharmacist.auth, 'sales', {
      from: addDays(lastMonth, -5),
      to: today(),
      groupBy: 'month',
    });

    const { periods, totals } = salesOf(res);
    expect(periods.map((p) => p.period)).toEqual([
      `${lastMonth.slice(0, 7)}-01`,
      `${today().slice(0, 7)}-01`,
    ]);
    expect(periods[0]).toMatchObject({ saleCount: 1, netSales: '67.50' });
    expect(periods[1]).toMatchObject({ saleCount: 1, netSales: '120.00' });
    expect(totals.revenue).toBe('152.50');

    const weekly = await report(t.pharmacist.auth, 'sales', { groupBy: 'week' });
    expect(weekly.status).toBe(200);
    expect(salesOf(weekly).periods.every((p) => new Date(p.period).getUTCDay() === 1)).toBe(true);
  });

  it('defaults to the last 30 days and validates the range', async () => {
    const { auth } = await authAs('ADMIN');
    const res = await report(auth, 'sales');
    expect(salesOf(res)).toMatchObject({
      from: addDays(today(), -29),
      to: today(),
      groupBy: 'day',
    });
    expect(salesOf(res).periods).toHaveLength(30);

    const backwards = await report(auth, 'sales', { from: today(), to: addDays(today(), -1) });
    expect(backwards.status).toBe(400);
    const tooLong = await report(auth, 'sales', { from: addDays(today(), -500), to: today() });
    expect(tooLong.status).toBe(400);
    const monthly = await report(auth, 'sales', {
      from: addDays(today(), -500),
      to: today(),
      groupBy: 'month',
    });
    expect(monthly.status).toBe(200);
  });
});

describe('GET /api/reports/medicines', () => {
  it('splits revenue, cost and profit per medicine and adds up to the sales report', async () => {
    const t = await tradingDay();

    const res = await report(t.pharmacist.auth, 'medicines', { sort: 'revenue' });

    expect(res.status).toBe(200);
    const body = res.body as MedicineReportDto;
    expect(body.items.map((i) => i.medicine.name)).toEqual(['Augmentin 625mg', 'Brufen 400mg']);
    expect(body.items[0]).toMatchObject({
      unitsSold: 7,
      unitsReturned: 1,
      netUnits: 6,
      netSales: '167.50',
      refunds: '25.00',
      revenue: '142.50',
      cost: '90.00',
      grossProfit: '52.50',
      marginPercent: '36.84',
    });
    // The damaged Brufen stays in cost: that unit is lost.
    expect(body.items[1]).toMatchObject({
      unitsSold: 2,
      unitsReturned: 1,
      revenue: '10.00',
      cost: '8.00',
      grossProfit: '2.00',
      marginPercent: '20.00',
    });

    const sales = salesOf(await report(t.pharmacist.auth, 'sales'));
    expect(body.totals).toMatchObject({
      medicines: 2,
      netSales: sales.totals.netSales,
      refunds: sales.totals.refunds,
      revenue: sales.totals.revenue,
      cost: sales.totals.cost,
      grossProfit: sales.totals.grossProfit,
    });
  });

  it('ranks best sellers by units, and filters and pages', async () => {
    const t = await tradingDay();
    const byUnits = (await report(t.pharmacist.auth, 'medicines', { sort: 'units' }))
      .body as MedicineReportDto;
    expect(byUnits.items.map((i) => i.netUnits)).toEqual([6, 1]);

    const byMargin = (await report(t.pharmacist.auth, 'medicines', { sort: 'margin' }))
      .body as MedicineReportDto;
    expect(byMargin.items[0]!.medicine.name).toBe('Augmentin 625mg');

    const searched = (await report(t.pharmacist.auth, 'medicines', { q: 'bruf' }))
      .body as MedicineReportDto;
    expect(searched.items.map((i) => i.medicine.name)).toEqual(['Brufen 400mg']);
    expect(searched.totals.revenue).toBe('10.00');

    const page2 = (await report(t.pharmacist.auth, 'medicines', { page: 2, pageSize: 1 }))
      .body as MedicineReportDto;
    expect(page2.total).toBe(2);
    expect(page2.items.map((i) => i.medicine.name)).toEqual(['Brufen 400mg']);
  });
});

describe('GET /api/reports/cashiers', () => {
  it('reports each cashier, with voids apart, adding up to the sales report', async () => {
    const t = await tradingDay();

    const res = await report(t.pharmacist.auth, 'cashiers');

    expect(res.status).toBe(200);
    const body = res.body as CashierReportDto;
    const cashier = body.cashiers.find((c) => c.cashier.id === t.cashier.user.id)!;
    expect(cashier).toMatchObject({
      saleCount: 1,
      unitsSold: 6,
      netSales: '120.00',
      refunds: '35.00',
      revenue: '85.00',
      averageBill: '120.00',
      voidedCount: 1,
      voidedTotal: '10.00',
      payments: { CASH: '120.00', CARD: '0.00', MOBILE_WALLET: '0.00' },
    });
    const pharmacist = body.cashiers.find((c) => c.cashier.id === t.pharmacist.user.id)!;
    expect(pharmacist).toMatchObject({
      saleCount: 1,
      netSales: '67.50',
      voidedCount: 0,
      payments: { CASH: '0.00', CARD: '67.50', MOBILE_WALLET: '0.00' },
    });
    expect(body.totals).toMatchObject({ saleCount: 2, revenue: '152.50', voidedCount: 1 });
    expect(body.cashiers.map((c) => c.cashier.id)).toEqual([
      t.cashier.user.id,
      t.pharmacist.user.id,
    ]);
  });
});

describe('report permissions and CSV', () => {
  it('are for admins and pharmacists only', async () => {
    const cashier = await authAs('CASHIER');
    for (const path of [
      'dashboard',
      'sales',
      'medicines',
      'dead-stock',
      'expiry',
      'low-stock',
      'supplier-purchases',
      'cashiers',
      'cash-closing',
    ]) {
      const res = await report(cashier.auth, path);
      expect(res.status, path).toBe(403);
    }
    const admin = await authAs('ADMIN');
    expect((await report(admin.auth, 'dashboard')).status).toBe(200);
  });

  it('exports CSV with exact amounts', async () => {
    const t = await tradingDay();

    const res = await report(t.pharmacist.auth, 'medicines', { format: 'csv' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="medicine-sales-/);
    expect(res.text.startsWith(BOM)).toBe(true);
    const lines = res.text.replace(BOM, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^Medicine,Generic name,Category,Unit,Units sold/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('Augmentin 625mg');
    expect(lines[1]).toContain(',142.50,90.00,52.50,36.84');

    const sales = await report(t.pharmacist.auth, 'sales', {
      format: 'csv',
      from: today(),
      to: today(),
    });
    expect(sales.text).toContain(
      `${today()},2,195.00,7.50,187.50,35.00,152.50,98.00,54.50,35.74,93.75`,
    );
  });
});
