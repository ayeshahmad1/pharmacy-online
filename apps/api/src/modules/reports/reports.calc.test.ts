import { describe, expect, it } from 'vitest';
import {
  ZERO_SUMS,
  addSums,
  average,
  buildCashClosing,
  daysOfCover,
  expiryBucket,
  expiryBucketsFor,
  percent,
  periodStart,
  periodStarts,
  profitOf,
  resolveRange,
  toMetrics,
} from './reports.calc';

describe('resolveRange', () => {
  it('defaults to the last 30 days ending today', () => {
    expect(resolveRange({}, '2026-10-25')).toEqual({ from: '2026-09-26', to: '2026-10-25' });
  });

  it('fills whichever end is missing', () => {
    expect(resolveRange({ from: '2026-10-01' }, '2026-10-25')).toEqual({
      from: '2026-10-01',
      to: '2026-10-25',
    });
    expect(resolveRange({ to: '2026-03-31' }, '2026-10-25')).toEqual({
      from: '2026-03-02',
      to: '2026-03-31',
    });
  });
});

describe('periods', () => {
  it('starts weeks on Monday and months on the 1st', () => {
    expect(periodStart('2026-10-25', 'week')).toBe('2026-10-19'); // Sunday → Monday before
    expect(periodStart('2026-10-19', 'week')).toBe('2026-10-19');
    expect(periodStart('2026-10-25', 'month')).toBe('2026-10-01');
    expect(periodStart('2026-10-25', 'day')).toBe('2026-10-25');
  });

  it('lists every period overlapping the range, across month and year ends', () => {
    expect(periodStarts('2026-12-30', '2027-01-02', 'day')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(periodStarts('2026-10-01', '2026-10-25', 'week')).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
    expect(periodStarts('2026-11-15', '2027-02-01', 'month')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
    // 31st-of-month starts must not skip February.
    expect(periodStarts('2027-01-31', '2027-03-01', 'month')).toEqual([
      '2027-01-01',
      '2027-02-01',
      '2027-03-01',
    ]);
  });
});

describe('ratios', () => {
  it('gives percentages to 2 decimals, rounding half away from zero', () => {
    expect(percent(1n, 3n)).toBe('33.33');
    expect(percent(2n, 3n)).toBe('66.67');
    expect(percent(1n, 8n)).toBe('12.50');
    expect(percent(-1n, 3n)).toBe('-33.33');
    expect(percent(-1n, 8n)).toBe('-12.50');
    expect(percent(5n, 5n)).toBe('100.00');
  });

  it('has no percentage of nothing', () => {
    expect(percent(100n, 0n)).toBeNull();
    expect(percent(100n, -5n)).toBeNull();
  });

  it('averages to the paisa, half up', () => {
    expect(average(1000n, 3)).toBe('3.33');
    expect(average(1001n, 2)).toBe('5.01'); // 500.5 paisa → 501
    expect(average(0n, 0)).toBeNull();
  });

  it('works out days of cover at the recent pace', () => {
    expect(daysOfCover(10, 30)).toBe(10);
    expect(daysOfCover(10, 45)).toBe(6);
    expect(daysOfCover(0, 30)).toBe(0);
    expect(daysOfCover(10, 0)).toBeNull();
  });
});

describe('sales metrics', () => {
  const sums = {
    saleCount: 3,
    grossSales: 100_00n,
    discounts: 10_00n,
    netSales: 90_00n,
    refunds: 15_00n,
    soldCost: 50_00n,
    restockedCost: 5_00n,
  };

  it('takes refunds off revenue and restocked units off cost', () => {
    expect(profitOf(sums)).toEqual({ revenue: 75_00n, cost: 45_00n, grossProfit: 30_00n });
  });

  it('formats every figure exactly', () => {
    expect(toMetrics(sums)).toEqual({
      saleCount: 3,
      grossSales: '100.00',
      discounts: '10.00',
      netSales: '90.00',
      refunds: '15.00',
      revenue: '75.00',
      cost: '45.00',
      grossProfit: '30.00',
      marginPercent: '40.00',
      averageBill: '30.00',
    });
  });

  it('shows a loss as a negative profit and margin', () => {
    const loss = toMetrics({ ...sums, soldCost: 100_00n, restockedCost: 0n });
    expect(loss.grossProfit).toBe('-25.00');
    expect(loss.marginPercent).toBe('-33.33');
  });

  it('adds up periods into totals', () => {
    expect(addSums(ZERO_SUMS, sums)).toEqual(sums);
    expect(addSums(sums, sums).netSales).toBe(180_00n);
    expect(toMetrics(ZERO_SUMS)).toMatchObject({
      revenue: '0.00',
      marginPercent: null,
      averageBill: null,
    });
  });
});

describe('expiry buckets', () => {
  it('buckets by days left', () => {
    expect(expiryBucket(-3)).toBe('EXPIRED');
    expect(expiryBucket(0)).toBe('EXPIRED');
    expect(expiryBucket(1)).toBe('DAYS_30');
    expect(expiryBucket(30)).toBe('DAYS_30');
    expect(expiryBucket(31)).toBe('DAYS_60');
    expect(expiryBucket(90)).toBe('DAYS_90');
    expect(expiryBucket(91)).toBe('LATER');
  });

  it('shows only the buckets the window reaches', () => {
    expect(expiryBucketsFor(30)).toEqual(['EXPIRED', 'DAYS_30']);
    expect(expiryBucketsFor(90)).toEqual(['EXPIRED', 'DAYS_30', 'DAYS_60', 'DAYS_90']);
    expect(expiryBucketsFor(180)).toHaveLength(5);
  });
});

describe('buildCashClosing', () => {
  const ali = { id: 'u-ali', username: 'ali', fullName: 'Ali Raza' };
  const sara = { id: 'u-sara', username: 'sara', fullName: 'Sara Khan' };
  const users = new Map([
    [ali.id, ali],
    [sara.id, sara],
  ]);

  it('nets sales against voids and refunds per method and per person', () => {
    const closing = buildCashClosing({
      sales: {
        counts: [
          { userId: ali.id, count: 3 },
          { userId: sara.id, count: 1 },
        ],
        amounts: [
          { userId: ali.id, method: 'CASH', amount: 500_00n },
          { userId: ali.id, method: 'CARD', amount: 200_00n },
          { userId: sara.id, method: 'MOBILE_WALLET', amount: 80_00n },
        ],
      },
      // Sara voided one of Ali's earlier sales: the cash went out of her hands.
      voids: {
        counts: [{ userId: sara.id, count: 1 }],
        amounts: [{ userId: sara.id, method: 'CASH', amount: 120_00n }],
      },
      refunds: {
        counts: [{ userId: ali.id, count: 1 }],
        amounts: [
          { userId: ali.id, method: 'CASH', amount: 30_00n },
          { userId: ali.id, method: 'CARD', amount: 20_00n },
        ],
      },
      users,
    });

    expect(closing.sales).toEqual({
      count: 4,
      byMethod: { CASH: '500.00', CARD: '200.00', MOBILE_WALLET: '80.00' },
      total: '780.00',
    });
    expect(closing.voids.total).toBe('120.00');
    expect(closing.refunds).toMatchObject({ count: 1, total: '50.00' });
    expect(closing.net).toEqual({ CASH: '350.00', CARD: '180.00', MOBILE_WALLET: '80.00' });
    expect(closing.expectedCash).toBe('350.00');

    const [first, second] = closing.people;
    expect(first!.user).toEqual(ali);
    expect(first!.expectedCash).toBe('470.00');
    expect(second!.user).toEqual(sara);
    expect(second!.expectedCash).toBe('-120.00');
    expect(second!.net.MOBILE_WALLET).toBe('80.00');
  });

  it('is all zeros on a quiet day', () => {
    const empty = { counts: [], amounts: [] };
    const closing = buildCashClosing({ sales: empty, voids: empty, refunds: empty, users });
    expect(closing.expectedCash).toBe('0.00');
    expect(closing.sales.count).toBe(0);
    expect(closing.people).toEqual([]);
  });
});
