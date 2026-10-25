// Pure report arithmetic, kept apart from the SQL so it can be unit-tested.
// Amounts arrive as paisa (BigInt) summed exactly by Postgres; everything
// derived here (revenue, profit, margins, averages, the cash drawer) stays
// in BigInt until it is formatted (CLAUDE.md rule 6).

import {
  DEFAULT_REPORT_DAYS,
  type CashClosingPersonDto,
  type CashFlowDto,
  type ExpiryBucket,
  type MethodAmounts,
  PAYMENT_METHODS,
  type PaymentMethod,
  type ReportGroupBy,
  type SaleUserRef,
  type SalesMetricsDto,
} from '@pharmacy/shared';
import { addDays, daysBetween, fromDateOnly, toDateOnly } from '../../lib/dates';
import { type Paisa, formatPaisa, sumPaisa } from '../../lib/money';

// ─── Ranges and periods ─────────────────────────────────────────────────────

/** Fills in a missing end of a report range: up to today, 30 days long. */
export function resolveRange(q: { from?: string; to?: string }, today: string) {
  const to = q.to ?? (q.from && q.from > today ? q.from : today);
  const from = q.from ?? addDays(to, -(DEFAULT_REPORT_DAYS - 1));
  return { from, to };
}

/** The first day of the period `date` falls in. Weeks start on Monday, as in Postgres. */
export function periodStart(date: string, groupBy: ReportGroupBy): string {
  if (groupBy === 'day') return date;
  if (groupBy === 'month') return `${date.slice(0, 7)}-01`;
  const weekday = fromDateOnly(date).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** Every period that overlaps from..to, oldest first. */
export function periodStarts(from: string, to: string, groupBy: ReportGroupBy): string[] {
  const starts: string[] = [];
  let current = periodStart(from, groupBy);
  while (current <= to) {
    starts.push(current);
    if (groupBy === 'day') current = addDays(current, 1);
    else if (groupBy === 'week') current = addDays(current, 7);
    else {
      const d = fromDateOnly(current);
      d.setUTCMonth(d.getUTCMonth() + 1);
      current = toDateOnly(d);
    }
  }
  return starts;
}

// ─── Ratios ─────────────────────────────────────────────────────────────────

/** a ÷ b rounded half away from zero to a whole number. b must be positive. */
function divideRounded(a: bigint, b: bigint): bigint {
  const negative = a < 0n;
  const abs = negative ? -a : a;
  const q = (abs * 2n + b) / (2n * b);
  return negative ? -q : q;
}

/** part ÷ whole as a percentage with 2 decimals ("23.45"), or null when whole is not positive. */
export function percent(part: Paisa, whole: Paisa): string | null {
  if (whole <= 0n) return null;
  // In hundredths of a percent, which formats exactly like paisa.
  return formatPaisa(divideRounded(part * 10_000n, whole));
}

/** total ÷ count to the paisa (half-up), or null for no sales. */
export function average(total: Paisa, count: number): string | null {
  if (count <= 0) return null;
  return formatPaisa(divideRounded(total, BigInt(count)));
}

/** How many whole days `stock` lasts at the pace of `soldInDays` units per `days` days. */
export function daysOfCover(stock: number, soldInDays: number, days = 30): number | null {
  if (soldInDays <= 0) return null;
  return Math.floor((Math.max(stock, 0) * days) / soldInDays);
}

// ─── Sales metrics ──────────────────────────────────────────────────────────

/** What the SQL sums for a set of sales (one period, one cashier, everything). */
export type SalesSums = {
  saleCount: number;
  grossSales: Paisa;
  discounts: Paisa;
  netSales: Paisa;
  /** Refunds of completed returns against these sales. */
  refunds: Paisa;
  /** Σ quantity × batch cost price of every line sold. */
  soldCost: Paisa;
  /** Σ quantity × batch cost price of returned units put back on the shelf. */
  restockedCost: Paisa;
};

export const ZERO_SUMS: SalesSums = {
  saleCount: 0,
  grossSales: 0n,
  discounts: 0n,
  netSales: 0n,
  refunds: 0n,
  soldCost: 0n,
  restockedCost: 0n,
};

export function addSums(a: SalesSums, b: SalesSums): SalesSums {
  return {
    saleCount: a.saleCount + b.saleCount,
    grossSales: a.grossSales + b.grossSales,
    discounts: a.discounts + b.discounts,
    netSales: a.netSales + b.netSales,
    refunds: a.refunds + b.refunds,
    soldCost: a.soldCost + b.soldCost,
    restockedCost: a.restockedCost + b.restockedCost,
  };
}

/**
 * Revenue is what customers paid less what was refunded. Cost counts every
 * unit sold at its batch's cost price, less units returned to the shelf;
 * damaged or expired returns stay in cost, since that stock is lost.
 */
export function profitOf(
  s: Pick<SalesSums, 'netSales' | 'refunds' | 'soldCost' | 'restockedCost'>,
) {
  const revenue = s.netSales - s.refunds;
  const cost = s.soldCost - s.restockedCost;
  return { revenue, cost, grossProfit: revenue - cost };
}

export function toMetrics(s: SalesSums): SalesMetricsDto {
  const { revenue, cost, grossProfit } = profitOf(s);
  return {
    saleCount: s.saleCount,
    grossSales: formatPaisa(s.grossSales),
    discounts: formatPaisa(s.discounts),
    netSales: formatPaisa(s.netSales),
    refunds: formatPaisa(s.refunds),
    revenue: formatPaisa(revenue),
    cost: formatPaisa(cost),
    grossProfit: formatPaisa(grossProfit),
    marginPercent: percent(grossProfit, revenue),
    averageBill: average(s.netSales, s.saleCount),
  };
}

// ─── Expiry ─────────────────────────────────────────────────────────────────

export function expiryBucket(daysToExpiry: number): ExpiryBucket {
  if (daysToExpiry <= 0) return 'EXPIRED';
  if (daysToExpiry <= 30) return 'DAYS_30';
  if (daysToExpiry <= 60) return 'DAYS_60';
  if (daysToExpiry <= 90) return 'DAYS_90';
  return 'LATER';
}

/** The buckets a window of `days` reaches, in order. Expired is always shown. */
export function expiryBucketsFor(days: number): ExpiryBucket[] {
  const buckets: ExpiryBucket[] = ['EXPIRED', 'DAYS_30'];
  if (days > 30) buckets.push('DAYS_60');
  if (days > 60) buckets.push('DAYS_90');
  if (days > 90) buckets.push('LATER');
  return buckets;
}

export const daysToExpiry = (expiryDate: string, today: string) => daysBetween(today, expiryDate);

// ─── Cash closing ───────────────────────────────────────────────────────────

/** One kind of money movement (sales, voids or refunds) for one day, per person. */
export type FlowInput = {
  /** Documents (sales, voided sales, returns) per person. */
  counts: { userId: string; count: number }[];
  /** Money per person and payment method. */
  amounts: { userId: string; method: PaymentMethod; amount: Paisa }[];
};

type MethodPaisa = Record<PaymentMethod, Paisa>;

const zeroMethods = (): MethodPaisa => ({ CASH: 0n, CARD: 0n, MOBILE_WALLET: 0n });

const formatMethods = (m: MethodPaisa): MethodAmounts => ({
  CASH: formatPaisa(m.CASH),
  CARD: formatPaisa(m.CARD),
  MOBILE_WALLET: formatPaisa(m.MOBILE_WALLET),
});

type Flow = { count: number; byMethod: MethodPaisa };

function flowOf(input: FlowInput, userId?: string): Flow {
  const flow: Flow = { count: 0, byMethod: zeroMethods() };
  for (const c of input.counts) if (!userId || c.userId === userId) flow.count += c.count;
  for (const a of input.amounts) {
    if (!userId || a.userId === userId) flow.byMethod[a.method] += a.amount;
  }
  return flow;
}

const toFlowDto = (flow: Flow): CashFlowDto => ({
  count: flow.count,
  byMethod: formatMethods(flow.byMethod),
  total: formatPaisa(sumPaisa(PAYMENT_METHODS.map((m) => flow.byMethod[m]))),
});

function netOf(sales: Flow, voids: Flow, refunds: Flow): MethodPaisa {
  const net = zeroMethods();
  for (const m of PAYMENT_METHODS) {
    net[m] = sales.byMethod[m] - voids.byMethod[m] - refunds.byMethod[m];
  }
  return net;
}

/**
 * The day's drawer: money in from sales, out for voids and refunds, per
 * payment method, overall and for each person involved. Net can be negative
 * (more refunded than taken), so it is formatted with a sign.
 */
export function buildCashClosing(input: {
  sales: FlowInput;
  voids: FlowInput;
  refunds: FlowInput;
  users: Map<string, SaleUserRef>;
}) {
  const totals = {
    sales: flowOf(input.sales),
    voids: flowOf(input.voids),
    refunds: flowOf(input.refunds),
  };
  const net = netOf(totals.sales, totals.voids, totals.refunds);

  const ids = new Set(
    [input.sales, input.voids, input.refunds].flatMap((f) => [
      ...f.counts.map((c) => c.userId),
      ...f.amounts.map((a) => a.userId),
    ]),
  );
  const people: CashClosingPersonDto[] = [...ids].map((userId) => {
    const sales = flowOf(input.sales, userId);
    const voids = flowOf(input.voids, userId);
    const refunds = flowOf(input.refunds, userId);
    const personNet = netOf(sales, voids, refunds);
    return {
      user: input.users.get(userId) ?? {
        id: userId,
        username: 'unknown',
        fullName: 'Unknown user',
      },
      sales: toFlowDto(sales),
      voids: toFlowDto(voids),
      refunds: toFlowDto(refunds),
      net: formatMethods(personNet),
      expectedCash: formatPaisa(personNet.CASH),
    };
  });
  people.sort(
    (a, b) => a.user.fullName.localeCompare(b.user.fullName) || a.user.id.localeCompare(b.user.id),
  );

  return {
    sales: toFlowDto(totals.sales),
    voids: toFlowDto(totals.voids),
    refunds: toFlowDto(totals.refunds),
    net: formatMethods(net),
    expectedCash: formatPaisa(net.CASH),
    people,
  };
}
