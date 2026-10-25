import type {
  DashboardDto,
  DeadStockReportDto,
  ExpiryReportDto,
  LowStockReportDto,
  SupplierPurchasesReportDto,
} from '@pharmacy/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { startOfBusinessDay } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { createBatch, createSupplier, daysFromToday, resetDatabase } from './helpers';
import { moveSale, report, today, tradingDay, yesterday } from './reports-fixtures';
import { cash, saleOf, salesSetup, sell } from './sales-fixtures';

beforeEach(resetDatabase);

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe('GET /api/reports/dead-stock', () => {
  it('lists stock that has sat unsold past the window, most money tied up first', async () => {
    const ctx = await salesSetup();
    const batch = async (
      name: string,
      quantity: number,
      costPrice: string,
      receivedDaysAgo: number,
    ) => {
      const m = await ctx.medicine(name, '20.00');
      const b = await createBatch({
        medicineId: m.id,
        supplierId: ctx.supplier.id,
        userId: ctx.pharmacist.user.id,
        expiryDate: daysFromToday(300),
        quantity,
        costPrice,
      });
      await prisma.batch.update({
        where: { id: b.id },
        data: { createdAt: daysAgo(receivedDaysAgo) },
      });
      return m;
    };
    const neverSold = await batch('Never Sold', 10, '12.00', 90);
    const soldLongAgo = await batch('Sold Long Ago', 30, '2.00', 90);
    const soldRecently = await batch('Sold Recently', 10, '5.00', 90);
    await batch('Just Arrived', 10, '5.00', 3);
    // Only expired stock: nothing sellable to be dead.
    const expiredOnly = await ctx.medicine('Expired Only');
    await createBatch({
      medicineId: expiredOnly.id,
      supplierId: ctx.supplier.id,
      userId: ctx.pharmacist.user.id,
      expiryDate: daysFromToday(-1),
      quantity: 10,
    });

    const old = saleOf(
      await sell(ctx.pharmacist.auth, {
        items: [{ medicineId: soldLongAgo.id, quantity: 2 }],
        payments: [cash('40')],
      }),
    );
    await prisma.sale.update({ where: { id: old.id }, data: { soldAt: daysAgo(70) } });
    await sell(ctx.pharmacist.auth, {
      items: [{ medicineId: soldRecently.id, quantity: 1 }],
      payments: [cash('20')],
    });

    const res = await report(ctx.pharmacist.auth, 'dead-stock', { days: 60 });

    expect(res.status).toBe(200);
    const body = res.body as DeadStockReportDto;
    expect(body.days).toBe(60);
    expect(body.items.map((i) => i.medicine.name)).toEqual(['Never Sold', 'Sold Long Ago']);
    expect(body.items[0]).toMatchObject({
      sellableQuantity: 10,
      costValue: '120.00',
      retailValue: '200.00',
      lastSoldAt: null,
    });
    expect(body.items[1]).toMatchObject({
      sellableQuantity: 28,
      costValue: '56.00',
      retailValue: '560.00',
    });
    expect(new Date(body.items[1]!.lastSoldAt!).getTime()).toBeLessThan(daysAgo(69).getTime());
    expect(body.totals).toEqual({
      medicines: 2,
      units: 38,
      costValue: '176.00',
      retailValue: '760.00',
    });
    expect(neverSold.id).toBe(body.items[0]!.medicine.id);

    // A 7-day window still skips today's sale and the delivery from 3 days ago; an 80-day
    // window counts the sale from 70 days ago as recent.
    const shorter = (await report(ctx.pharmacist.auth, 'dead-stock', { days: 7 }))
      .body as DeadStockReportDto;
    expect(shorter.items.map((i) => i.medicine.name)).toEqual(['Never Sold', 'Sold Long Ago']);
    const longer = (await report(ctx.pharmacist.auth, 'dead-stock', { days: 80 }))
      .body as DeadStockReportDto;
    expect(longer.items.map((i) => i.medicine.name)).toEqual(['Never Sold']);
  });
});

describe('GET /api/reports/expiry', () => {
  it('lists expired and expiring batches with stock, bucketed and valued', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Calpol Syrup', '150.00');
    const add = (days: number, quantity: number) =>
      createBatch({
        medicineId: m.id,
        supplierId: ctx.supplier.id,
        userId: ctx.pharmacist.user.id,
        expiryDate: daysFromToday(days),
        quantity,
        costPrice: '100.00',
      });
    await add(-10, 2);
    await add(0, 1); // expires today: already expired
    await add(20, 3);
    await add(45, 4);
    await add(85, 5);
    await add(200, 6); // outside a 90-day window
    const emptied = await add(10, 1);
    await prisma.stockMovement.create({
      data: {
        batchId: emptied.id,
        type: 'ADJUSTMENT',
        quantity: -1,
        reason: 'Broken',
        userId: ctx.pharmacist.user.id,
      },
    });

    const res = await report(ctx.pharmacist.auth, 'expiry', { days: 90 });

    expect(res.status).toBe(200);
    const body = res.body as ExpiryReportDto;
    expect(body.until).toBe(daysFromToday(90));
    expect(body.buckets).toEqual([
      { bucket: 'EXPIRED', batches: 2, units: 3, costValue: '300.00', retailValue: '450.00' },
      { bucket: 'DAYS_30', batches: 1, units: 3, costValue: '300.00', retailValue: '450.00' },
      { bucket: 'DAYS_60', batches: 1, units: 4, costValue: '400.00', retailValue: '600.00' },
      { bucket: 'DAYS_90', batches: 1, units: 5, costValue: '500.00', retailValue: '750.00' },
    ]);
    expect(body.total).toBe(5);
    expect(body.items.map((i) => [i.daysToExpiry, i.isExpired, i.bucket])).toEqual([
      [-10, true, 'EXPIRED'],
      [0, true, 'EXPIRED'],
      [20, false, 'DAYS_30'],
      [45, false, 'DAYS_60'],
      [85, false, 'DAYS_90'],
    ]);

    const narrow = (await report(ctx.pharmacist.auth, 'expiry', { days: 30 }))
      .body as ExpiryReportDto;
    expect(narrow.buckets.map((b) => b.bucket)).toEqual(['EXPIRED', 'DAYS_30']);
    expect(narrow.total).toBe(3);
  });
});

describe('GET /api/reports/low-stock', () => {
  it('adds the sales pace, days of cover and last supplier', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Disprin', '5.00');
    await prisma.medicine.update({ where: { id: m.id }, data: { reorderLevel: 50 } });
    const other = await createSupplier('Second Supplier');
    await createBatch({
      medicineId: m.id,
      supplierId: other.id,
      userId: ctx.pharmacist.user.id,
      expiryDate: daysFromToday(300),
      quantity: 40,
      costPrice: '3.25',
    });
    await sell(ctx.pharmacist.auth, {
      items: [{ medicineId: m.id, quantity: 10 }],
      payments: [cash('50')],
    });
    const plenty = await ctx.medicine('Plenty');
    await ctx.batch(plenty.id, 300, 500);

    const res = await report(ctx.pharmacist.auth, 'low-stock');

    expect(res.status).toBe(200);
    const body = res.body as LowStockReportDto;
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      medicine: { name: 'Disprin', reorderLevel: 50 },
      sellableQuantity: 30,
      shortBy: 20,
      soldLast30Days: 10,
      daysOfCover: 90,
      lastSupplier: { id: other.id, name: 'Second Supplier' },
      lastCostPrice: '3.25',
    });
  });
});

describe('GET /api/reports/supplier-purchases', () => {
  it('totals receipts per supplier in the range, with lines for one supplier', async () => {
    const ctx = await salesSetup();
    const m = await ctx.medicine('Panadol');
    const second = await createSupplier('Second Supplier');
    const receive = async (supplierId: string, quantity: number, costPrice: string, at?: Date) => {
      const b = await prisma.batch.create({
        data: {
          medicineId: m.id,
          supplierId,
          batchNumber: `B-${quantity}`,
          expiryDate: new Date(`${daysFromToday(300)}T00:00:00Z`),
          costPrice,
          quantityReceived: quantity,
        },
      });
      await prisma.stockMovement.create({
        data: {
          batchId: b.id,
          type: 'PURCHASE',
          quantity,
          reason: 'Invoice INV-1',
          userId: ctx.pharmacist.user.id,
          ...(at && { createdAt: at }),
        },
      });
    };
    await receive(ctx.supplier.id, 100, '2.50');
    await receive(ctx.supplier.id, 20, '3.00');
    await receive(second.id, 10, '9.99');
    await receive(second.id, 50, '1.00', startOfBusinessDay(daysFromToday(-40))); // outside the range

    const res = await report(ctx.pharmacist.auth, 'supplier-purchases', {
      from: yesterday(),
      to: today(),
    });

    expect(res.status).toBe(200);
    const body = res.body as SupplierPurchasesReportDto;
    expect(body.totals).toEqual({ suppliers: 2, batches: 3, units: 130, value: '409.90' });
    expect(body.suppliers.map((s) => [s.supplier.name, s.batches, s.units, s.value])).toEqual([
      ['Pak Pharma Distributors', 2, 120, '310.00'],
      ['Second Supplier', 1, 10, '99.90'],
    ]);
    expect(body.lines).toBeNull();

    const one = (
      await report(ctx.pharmacist.auth, 'supplier-purchases', {
        supplierId: second.id,
        from: daysFromToday(-60),
      })
    ).body as SupplierPurchasesReportDto;
    expect(one.totals.value).toBe('149.90');
    expect(one.lines!.map((l) => [l.quantity, l.costPrice, l.value, l.reference])).toEqual([
      [10, '9.99', '99.90', 'Invoice INV-1'],
      [50, '1.00', '50.00', 'Invoice INV-1'],
    ]);
  });
});

describe('GET /api/reports/dashboard', () => {
  it('summarises today, the month and the trend', async () => {
    const t = await tradingDay();
    await moveSale(t.s2.id, yesterday());
    await prisma.medicine.update({ where: { id: t.brufen.id }, data: { reorderLevel: 200 } });

    const res = await report(t.pharmacist.auth, 'dashboard');

    expect(res.status).toBe(200);
    const body = res.body as DashboardDto;
    expect(body.businessDate).toBe(today());
    expect(body.today).toMatchObject({ saleCount: 1, netSales: '120.00', revenue: '85.00' });
    expect(body.yesterday).toMatchObject({ saleCount: 1, netSales: '67.50' });
    expect(body.trend).toHaveLength(30);
    expect(body.trend.at(-1)!.period).toBe(today());
    expect(body.bestSellers.map((b) => b.medicine.name)).toEqual([
      'Augmentin 625mg',
      'Brufen 400mg',
    ]);
    expect(body.paymentsToday).toEqual([
      { method: 'CASH', count: 1, amount: '120.00' },
      { method: 'CARD', count: 0, amount: '0.00' },
      { method: 'MOBILE_WALLET', count: 0, amount: '0.00' },
    ]);
    expect(body.stock).toMatchObject({
      lowStock: 1,
      outOfStock: 0,
      expiringSoon: 0,
      expiredOnShelf: 0,
    });
    const monthStartedYesterday = yesterday().slice(0, 7) !== today().slice(0, 7);
    expect(body.monthToDate.saleCount).toBe(monthStartedYesterday ? 1 : 2);
  });
});
