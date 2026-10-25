import {
  type CashClosingQuery,
  type CashClosingReportDto,
  type CashierReportDto,
  type CashierSalesRowDto,
  type DashboardDto,
  type DeadStockQuery,
  type DeadStockReportDto,
  type ExpiryBucket,
  type ExpiryReportDto,
  type ExpiryReportQuery,
  type LowStockReportDto,
  type LowStockReportQuery,
  MAX_DAILY_REPORT_DAYS,
  MAX_REPORT_DAYS,
  type MedicineReportDto,
  type MedicineReportQuery,
  type MedicineSalesDto,
  type PaymentMethod,
  type PaymentMixDto,
  type ReportGroupBy,
  type ReportMedicineRef,
  type ReportRangeQuery,
  type SaleUserRef,
  type SalesPeriodDto,
  type SalesReportDto,
  type SalesReportQuery,
  type SupplierPurchasesQuery,
  type SupplierPurchasesReportDto,
  rangeDays,
} from '@pharmacy/shared';
import { Prisma } from '@prisma/client';
import { config } from '../../lib/config';
import { addDays, businessToday, startOfBusinessDay, toDateOnly } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { type Paisa, formatPaisa, toPaisa } from '../../lib/money';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';
import { batchQuantitySql, medicineStockTotalsSql } from '../../lib/stock';
import {
  type FlowInput,
  type SalesSums,
  ZERO_SUMS,
  addSums,
  average,
  buildCashClosing,
  daysOfCover,
  daysToExpiry,
  expiryBucket,
  expiryBucketsFor,
  percent,
  periodStart,
  periodStarts,
  profitOf,
  resolveRange,
  toMetrics,
} from './reports.calc';

// Every report reads; none writes. Sales count on their counter day
// (Sale.soldAt in the pharmacy's timezone); voided sales are left out; a
// completed return's refund comes off the day of the sale it was returned
// against (decided in Session 11). Only the cash-closing report follows the
// drawer instead: voids and refunds count on the day the money went back.

type Page = { page: number; pageSize: number };

/** Largest number of rows a CSV export carries. */
export const CSV_MAX_ROWS = 50_000;

/** A Postgres numeric (possibly negative) as paisa. Null (no rows) is 0. */
function paisa(value: Prisma.Decimal | null | undefined): Paisa {
  if (!value) return 0n;
  return value.isNegative() ? -toPaisa(value.abs()) : toPaisa(value);
}

const money = (value: Prisma.Decimal | null | undefined) => formatPaisa(paisa(value));

/** Instants bounding the business days from..to, for filtering timestamps. */
function bounds(from: string, to: string) {
  return {
    start: startOfBusinessDay(from).toISOString(),
    end: startOfBusinessDay(addDays(to, 1)).toISOString(),
  };
}

function checkedRange(q: { from?: string; to?: string }, maxDays = MAX_REPORT_DAYS) {
  const range = resolveRange(q, businessToday());
  if (rangeDays(range.from, range.to) > maxDays) {
    throw badRequest(`Choose a range of at most ${maxDays} days`, { field: 'from' });
  }
  return range;
}

const pageSql = (q: Page) => Prisma.sql`LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

/** Sales that count in reports (not voided) made between two instants, as CTE `sales`. */
function salesCte(start: string, end: string) {
  return Prisma.sql`
    sales AS (
      SELECT s."id", s."cashierId", s."soldAt", s."subtotal", s."discountTotal", s."grandTotal"
      FROM "Sale" s
      WHERE s."soldAt" >= ${start}::timestamptz AND s."soldAt" < ${end}::timestamptz
        AND s."status" IN ('COMPLETED', 'REFUNDED')
    )`;
}

/**
 * Per sale in `sales`: cost of its lines (`line_costs`), and the refunds and
 * restocked cost of its completed returns (`sale_returns`).
 */
const saleCostCtes = Prisma.sql`
  line_costs AS (
    SELECT si."saleId", SUM(si."quantity" * b."costPrice") AS "soldCost", SUM(si."quantity")::int AS "units"
    FROM sales
    JOIN "SaleItem" si ON si."saleId" = sales."id"
    JOIN "Batch" b ON b."id" = si."batchId"
    GROUP BY si."saleId"
  ),
  sale_returns AS (
    SELECT r."saleId",
      SUM(ri."refundAmount") AS "refunds",
      COALESCE(SUM(ri."quantity" * b."costPrice") FILTER (WHERE ri."restock"), 0) AS "restockedCost"
    FROM sales
    JOIN "Return" r ON r."saleId" = sales."id" AND r."status" = 'COMPLETED'
    JOIN "ReturnItem" ri ON ri."returnId" = r."id"
    JOIN "SaleItem" si ON si."id" = ri."saleItemId"
    JOIN "Batch" b ON b."id" = si."batchId"
    GROUP BY r."saleId"
  )`;

/** Column list summing `sales` joined to line_costs (lc) and sale_returns (sr). */
const sumColumns = Prisma.sql`
  count(*)::int AS "saleCount",
  SUM(sales."subtotal") AS "grossSales",
  SUM(sales."discountTotal") AS "discounts",
  SUM(sales."grandTotal") AS "netSales",
  SUM(sr."refunds") AS "refunds",
  SUM(lc."soldCost") AS "soldCost",
  SUM(sr."restockedCost") AS "restockedCost",
  COALESCE(SUM(lc."units"), 0)::int AS "units"`;

type SumRow = {
  saleCount: number;
  grossSales: Prisma.Decimal | null;
  discounts: Prisma.Decimal | null;
  netSales: Prisma.Decimal | null;
  refunds: Prisma.Decimal | null;
  soldCost: Prisma.Decimal | null;
  restockedCost: Prisma.Decimal | null;
  units: number;
};

const toSums = (r: SumRow): SalesSums => ({
  saleCount: r.saleCount,
  grossSales: paisa(r.grossSales),
  discounts: paisa(r.discounts),
  netSales: paisa(r.netSales),
  refunds: paisa(r.refunds),
  soldCost: paisa(r.soldCost),
  restockedCost: paisa(r.restockedCost),
});

const salesFrom = Prisma.sql`
  FROM sales
  LEFT JOIN line_costs lc ON lc."saleId" = sales."id"
  LEFT JOIN sale_returns sr ON sr."saleId" = sales."id"`;

// ─── Sales over time ────────────────────────────────────────────────────────

async function salesPeriods(from: string, to: string, groupBy: ReportGroupBy) {
  const { start, end } = bounds(from, to);
  const rows = await prisma.$queryRaw<(SumRow & { period: Date })[]>`
    WITH ${salesCte(start, end)}, ${saleCostCtes}
    SELECT date_trunc(${groupBy}, sales."soldAt" AT TIME ZONE ${config.BUSINESS_TIMEZONE})::date AS "period",
      ${sumColumns}
    ${salesFrom}
    GROUP BY 1`;
  const byPeriod = new Map(rows.map((r) => [toDateOnly(r.period), toSums(r)]));

  let totals = ZERO_SUMS;
  const periods: SalesPeriodDto[] = periodStarts(from, to, groupBy).map((period) => {
    const sums = byPeriod.get(period) ?? ZERO_SUMS;
    totals = addSums(totals, sums);
    return { period, ...toMetrics(sums) };
  });
  return { totals, periods };
}

/** Sales, refunds, cost and profit per day, week or month. */
export async function salesReport(query: SalesReportQuery): Promise<SalesReportDto> {
  const max = query.groupBy === 'day' ? MAX_DAILY_REPORT_DAYS : MAX_REPORT_DAYS;
  const { from, to } = checkedRange(query, max);
  const { totals, periods } = await salesPeriods(from, to, query.groupBy);
  return { from, to, groupBy: query.groupBy, totals: toMetrics(totals), periods };
}

// ─── Per medicine ───────────────────────────────────────────────────────────

const MEDICINE_SORT: Record<MedicineReportQuery['sort'], Prisma.Sql> = {
  revenue: Prisma.sql`"revenue" DESC`,
  profit: Prisma.sql`("revenue" - "cost") DESC`,
  margin: Prisma.sql`CASE WHEN "revenue" > 0 THEN ("revenue" - "cost") / "revenue" END DESC NULLS LAST`,
  units: Prisma.sql`("unitsSold" - "unitsReturned") DESC`,
  name: Prisma.sql`"name" ASC`,
};

type MedicineRow = {
  id: string;
  name: string;
  genericName: string | null;
  unit: string;
  category: string;
  unitsSold: number;
  unitsReturned: number;
  netSales: Prisma.Decimal;
  refunds: Prisma.Decimal;
  soldCost: Prisma.Decimal;
  restockedCost: Prisma.Decimal;
};

function toMedicineSales(r: Omit<MedicineRow, keyof ReportMedicineRef>) {
  const sums = {
    netSales: paisa(r.netSales),
    refunds: paisa(r.refunds),
    soldCost: paisa(r.soldCost),
    restockedCost: paisa(r.restockedCost),
  };
  const { revenue, cost, grossProfit } = profitOf(sums);
  return {
    unitsSold: r.unitsSold,
    unitsReturned: r.unitsReturned,
    netUnits: r.unitsSold - r.unitsReturned,
    netSales: formatPaisa(sums.netSales),
    refunds: formatPaisa(sums.refunds),
    revenue: formatPaisa(revenue),
    cost: formatPaisa(cost),
    grossProfit: formatPaisa(grossProfit),
    marginPercent: percent(grossProfit, revenue),
  };
}

/**
 * Units, revenue, cost and profit per medicine for sales made from..to.
 * Sorted by units or revenue, it is the best-sellers list.
 */
export async function medicineReport(query: MedicineReportQuery): Promise<MedicineReportDto> {
  const { from, to } = checkedRange(query);
  const { start, end } = bounds(from, to);

  const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.categoryId) filters.push(Prisma.sql`m."categoryId" = ${query.categoryId}::uuid`);
  if (query.q) {
    const contains = `%${escapeLike(query.q)}%`;
    filters.push(Prisma.sql`(m."name" ILIKE ${contains} OR m."genericName" ILIKE ${contains})`);
  }

  const rowsCte = Prisma.sql`
    WITH ${salesCte(start, end)},
    sold AS (
      SELECT b."medicineId",
        SUM(si."quantity")::int AS "unitsSold",
        SUM(si."lineTotal") AS "netSales",
        SUM(si."quantity" * b."costPrice") AS "soldCost"
      FROM sales
      JOIN "SaleItem" si ON si."saleId" = sales."id"
      JOIN "Batch" b ON b."id" = si."batchId"
      GROUP BY b."medicineId"
    ),
    returned AS (
      SELECT b."medicineId",
        SUM(ri."quantity")::int AS "unitsReturned",
        SUM(ri."refundAmount") AS "refunds",
        COALESCE(SUM(ri."quantity" * b."costPrice") FILTER (WHERE ri."restock"), 0) AS "restockedCost"
      FROM sales
      JOIN "Return" r ON r."saleId" = sales."id" AND r."status" = 'COMPLETED'
      JOIN "ReturnItem" ri ON ri."returnId" = r."id"
      JOIN "SaleItem" si ON si."id" = ri."saleItemId"
      JOIN "Batch" b ON b."id" = si."batchId"
      GROUP BY b."medicineId"
    ),
    rows AS (
      SELECT m."id", m."name", m."genericName", m."unit", c."name" AS "category",
        sold."unitsSold", COALESCE(ret."unitsReturned", 0) AS "unitsReturned",
        sold."netSales", COALESCE(ret."refunds", 0) AS "refunds",
        sold."soldCost", COALESCE(ret."restockedCost", 0) AS "restockedCost",
        sold."netSales" - COALESCE(ret."refunds", 0) AS "revenue",
        sold."soldCost" - COALESCE(ret."restockedCost", 0) AS "cost"
      FROM sold
      JOIN "Medicine" m ON m."id" = sold."medicineId"
      JOIN "Category" c ON c."id" = m."categoryId"
      LEFT JOIN returned ret ON ret."medicineId" = sold."medicineId"
      WHERE ${Prisma.join(filters, ' AND ')}
    )`;

  const [[totalsRow], rows] = await prisma.$transaction([
    prisma.$queryRaw<
      [
        {
          medicines: number;
          unitsSold: number;
          unitsReturned: number;
          netSales: Prisma.Decimal | null;
          refunds: Prisma.Decimal | null;
          soldCost: Prisma.Decimal | null;
          restockedCost: Prisma.Decimal | null;
        },
      ]
    >`
      ${rowsCte}
      SELECT count(*)::int AS "medicines",
        COALESCE(SUM("unitsSold"), 0)::int AS "unitsSold",
        COALESCE(SUM("unitsReturned"), 0)::int AS "unitsReturned",
        SUM("netSales") AS "netSales", SUM("refunds") AS "refunds",
        SUM("soldCost") AS "soldCost", SUM("restockedCost") AS "restockedCost"
      FROM rows`,
    prisma.$queryRaw<MedicineRow[]>`
      ${rowsCte}
      SELECT * FROM rows
      ORDER BY ${MEDICINE_SORT[query.sort]}, "name", "id" ${pageSql(query)}`,
  ]);

  const items: MedicineSalesDto[] = rows.map((r) => ({
    medicine: {
      id: r.id,
      name: r.name,
      genericName: r.genericName,
      unit: r.unit,
      category: r.category,
    },
    ...toMedicineSales(r),
  }));
  const { medicines, ...totals } = totalsRow;
  return {
    from,
    to,
    sort: query.sort,
    totals: {
      medicines,
      ...toMedicineSales({
        ...totals,
        netSales: totals.netSales ?? new Prisma.Decimal(0),
        refunds: totals.refunds ?? new Prisma.Decimal(0),
        soldCost: totals.soldCost ?? new Prisma.Decimal(0),
        restockedCost: totals.restockedCost ?? new Prisma.Decimal(0),
      }),
    },
    items,
    total: medicines,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ─── Dead stock ─────────────────────────────────────────────────────────────

/**
 * Medicines holding sellable stock that has sat for at least `days` days
 * without a sale: no (non-voided) sale since the cutoff, and some of the
 * stock arrived before it, so a delivery that came in yesterday is not
 * "dead". Most tied-up money first.
 */
export async function deadStockReport(query: DeadStockQuery): Promise<DeadStockReportDto> {
  const today = businessToday();
  const days = query.days ?? config.DEAD_STOCK_DAYS;
  const since = startOfBusinessDay(addDays(today, -days)).toISOString();
  const category = query.categoryId
    ? Prisma.sql`AND m."categoryId" = ${query.categoryId}::uuid`
    : Prisma.empty;

  const rowsCte = Prisma.sql`
    WITH stock AS (
      SELECT b."medicineId",
        SUM(q."qty")::int AS "units",
        SUM(q."qty" * b."costPrice") AS "costValue",
        MIN(b."createdAt") AS "oldestReceivedAt"
      FROM "Batch" b
      CROSS JOIN LATERAL (SELECT ${batchQuantitySql} AS "qty") q
      WHERE b."expiryDate" > ${today}::date AND q."qty" > 0
      GROUP BY b."medicineId"
    ),
    rows AS (
      SELECT m."id", m."name", m."genericName", m."unit", m."sellingPrice", c."name" AS "category",
        stock."units", stock."costValue", stock."units" * m."sellingPrice" AS "retailValue",
        stock."oldestReceivedAt"
      FROM stock
      JOIN "Medicine" m ON m."id" = stock."medicineId"
      JOIN "Category" c ON c."id" = m."categoryId"
      WHERE stock."oldestReceivedAt" < ${since}::timestamptz ${category}
        AND NOT EXISTS (
          SELECT 1 FROM "Batch" sb
          JOIN "SaleItem" si ON si."batchId" = sb."id"
          JOIN "Sale" s ON s."id" = si."saleId"
          WHERE sb."medicineId" = m."id" AND s."soldAt" >= ${since}::timestamptz
            AND s."status" IN ('COMPLETED', 'REFUNDED')
        )
    )`;

  const [[totals], rows] = await prisma.$transaction([
    prisma.$queryRaw<
      [
        {
          medicines: number;
          units: number;
          costValue: Prisma.Decimal | null;
          retailValue: Prisma.Decimal | null;
        },
      ]
    >`
      ${rowsCte}
      SELECT count(*)::int AS "medicines", COALESCE(SUM("units"), 0)::int AS "units",
        SUM("costValue") AS "costValue", SUM("retailValue") AS "retailValue"
      FROM rows`,
    prisma.$queryRaw<
      {
        id: string;
        name: string;
        genericName: string | null;
        unit: string;
        sellingPrice: Prisma.Decimal;
        category: string;
        units: number;
        costValue: Prisma.Decimal;
        retailValue: Prisma.Decimal;
        oldestReceivedAt: Date;
        lastSoldAt: Date | null;
      }[]
    >`
      ${rowsCte}
      SELECT rows.*, ls."lastSoldAt"
      FROM (SELECT * FROM rows ORDER BY "costValue" DESC, "name", "id" ${pageSql(query)}) rows
      LEFT JOIN LATERAL (
        SELECT MAX(s."soldAt") AS "lastSoldAt"
        FROM "Batch" sb
        JOIN "SaleItem" si ON si."batchId" = sb."id"
        JOIN "Sale" s ON s."id" = si."saleId"
        WHERE sb."medicineId" = rows."id" AND s."status" IN ('COMPLETED', 'REFUNDED')
      ) ls ON TRUE
      ORDER BY rows."costValue" DESC, rows."name", rows."id"`,
  ]);

  return {
    days,
    since,
    totals: {
      medicines: totals.medicines,
      units: totals.units,
      costValue: money(totals.costValue),
      retailValue: money(totals.retailValue),
    },
    items: rows.map((r) => ({
      medicine: {
        id: r.id,
        name: r.name,
        genericName: r.genericName,
        unit: r.unit,
        category: r.category,
        sellingPrice: r.sellingPrice.toFixed(2),
      },
      sellableQuantity: r.units,
      costValue: money(r.costValue),
      retailValue: money(r.retailValue),
      lastSoldAt: r.lastSoldAt?.toISOString() ?? null,
      oldestStockReceivedAt: r.oldestReceivedAt.toISOString(),
    })),
    total: totals.medicines,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ─── Expiry ─────────────────────────────────────────────────────────────────

/**
 * Batches with stock that have expired (never sellable, to be written off)
 * or expire within `days` days, soonest first, valued at cost and retail,
 * with totals per bucket (expired, ≤30, ≤60, ≤90 days, later).
 */
export async function expiryReport(query: ExpiryReportQuery): Promise<ExpiryReportDto> {
  const today = businessToday();
  const days = query.days ?? config.EXPIRY_WARNING_DAYS;
  const until = addDays(today, days);
  const from = Prisma.sql`
    FROM "Batch" b
    CROSS JOIN LATERAL (SELECT ${batchQuantitySql} AS "qty") q
    JOIN "Medicine" m ON m."id" = b."medicineId"
    WHERE b."expiryDate" <= ${until}::date AND q."qty" > 0`;
  // Days to expiry as Postgres sees it (date − date is whole days).
  const bucketSql = Prisma.sql`CASE
    WHEN b."expiryDate" - ${today}::date <= 0 THEN 'EXPIRED'
    WHEN b."expiryDate" - ${today}::date <= 30 THEN 'DAYS_30'
    WHEN b."expiryDate" - ${today}::date <= 60 THEN 'DAYS_60'
    WHEN b."expiryDate" - ${today}::date <= 90 THEN 'DAYS_90'
    ELSE 'LATER' END`;

  const [bucketRows, rows] = await prisma.$transaction([
    prisma.$queryRaw<
      {
        bucket: ExpiryBucket;
        batches: number;
        units: number;
        costValue: Prisma.Decimal;
        retailValue: Prisma.Decimal;
      }[]
    >`
      SELECT ${bucketSql} AS "bucket", count(*)::int AS "batches", SUM(q."qty")::int AS "units",
        SUM(q."qty" * b."costPrice") AS "costValue", SUM(q."qty" * m."sellingPrice") AS "retailValue"
      ${from}
      GROUP BY 1`,
    prisma.$queryRaw<
      {
        id: string;
        batchNumber: string;
        expiryDate: Date;
        qty: number;
        costPrice: Prisma.Decimal;
        medicineId: string;
        name: string;
        genericName: string | null;
        unit: string;
        sellingPrice: Prisma.Decimal;
        category: string;
        supplierId: string;
        supplierName: string;
      }[]
    >`
      SELECT b."id", b."batchNumber", b."expiryDate", q."qty", b."costPrice",
        m."id" AS "medicineId", m."name", m."genericName", m."unit", m."sellingPrice",
        c."name" AS "category", sup."id" AS "supplierId", sup."name" AS "supplierName"
      FROM "Batch" b
      CROSS JOIN LATERAL (SELECT ${batchQuantitySql} AS "qty") q
      JOIN "Medicine" m ON m."id" = b."medicineId"
      JOIN "Category" c ON c."id" = m."categoryId"
      JOIN "Supplier" sup ON sup."id" = b."supplierId"
      WHERE b."expiryDate" <= ${until}::date AND q."qty" > 0
      ORDER BY b."expiryDate", m."name", b."id" ${pageSql(query)}`,
  ]);

  const byBucket = new Map(bucketRows.map((r) => [r.bucket, r]));
  const buckets = expiryBucketsFor(days).map((bucket) => {
    const r = byBucket.get(bucket);
    return {
      bucket,
      batches: r?.batches ?? 0,
      units: r?.units ?? 0,
      costValue: money(r?.costValue),
      retailValue: money(r?.retailValue),
    };
  });

  return {
    today,
    days,
    until,
    buckets,
    items: rows.map((r) => {
      const expiryDate = toDateOnly(r.expiryDate);
      const left = daysToExpiry(expiryDate, today);
      return {
        batch: { id: r.id, batchNumber: r.batchNumber, expiryDate },
        medicine: {
          id: r.medicineId,
          name: r.name,
          genericName: r.genericName,
          unit: r.unit,
          category: r.category,
        },
        supplier: { id: r.supplierId, name: r.supplierName },
        quantity: r.qty,
        daysToExpiry: left,
        isExpired: left <= 0,
        bucket: expiryBucket(left),
        costValue: formatPaisa(paisa(r.costPrice) * BigInt(r.qty)),
        retailValue: formatPaisa(paisa(r.sellingPrice) * BigInt(r.qty)),
      };
    }),
    total: buckets.reduce((sum, b) => sum + b.batches, 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ─── Low stock ──────────────────────────────────────────────────────────────

const PACE_DAYS = 30;

/**
 * Active medicines whose sellable stock is at or below the reorder level
 * (the same list as inventory's low-stock view), with the last 30 days' sales
 * pace, how long the stock will last at it, and where it last came from.
 */
export async function lowStockReport(query: LowStockReportQuery): Promise<LowStockReportDto> {
  const today = businessToday();
  const paceStart = startOfBusinessDay(addDays(today, -(PACE_DAYS - 1))).toISOString();
  const category = query.categoryId
    ? Prisma.sql`AND m."categoryId" = ${query.categoryId}::uuid`
    : Prisma.empty;
  const low = Prisma.sql`
    SELECT m."id", m."name", m."genericName", m."unit", m."reorderLevel", c."name" AS "category",
      s."sellable", s."expired"
    FROM "Medicine" m
    JOIN "Category" c ON c."id" = m."categoryId"
    CROSS JOIN LATERAL (${medicineStockTotalsSql(today)}) s
    WHERE m."status" = 'ACTIVE' AND s."sellable" <= m."reorderLevel" ${category}`;

  const [[{ total }], rows] = await prisma.$transaction([
    prisma.$queryRaw<[{ total: number }]>`SELECT count(*)::int AS "total" FROM (${low}) low`,
    prisma.$queryRaw<
      {
        id: string;
        name: string;
        genericName: string | null;
        unit: string;
        reorderLevel: number;
        category: string;
        sellable: number;
        expired: number;
        sold: number;
        returned: number;
        supplierId: string | null;
        supplierName: string | null;
        costPrice: Prisma.Decimal | null;
        receivedAt: Date | null;
      }[]
    >`
      SELECT low.*, sold."sold", sold."returned",
        lb."supplierId", lb."supplierName", lb."costPrice", lb."receivedAt"
      FROM (${low} ORDER BY s."sellable", m."name", m."id" ${pageSql(query)}) low
      CROSS JOIN LATERAL (
        SELECT
          COALESCE((
            SELECT SUM(si."quantity") FROM "Batch" b
            JOIN "SaleItem" si ON si."batchId" = b."id"
            JOIN "Sale" s ON s."id" = si."saleId"
            WHERE b."medicineId" = low."id" AND s."soldAt" >= ${paceStart}::timestamptz
              AND s."status" IN ('COMPLETED', 'REFUNDED')
          ), 0)::int AS "sold",
          COALESCE((
            SELECT SUM(ri."quantity") FROM "Batch" b
            JOIN "SaleItem" si ON si."batchId" = b."id"
            JOIN "Sale" s ON s."id" = si."saleId"
            JOIN "ReturnItem" ri ON ri."saleItemId" = si."id"
            JOIN "Return" r ON r."id" = ri."returnId" AND r."status" = 'COMPLETED'
            WHERE b."medicineId" = low."id" AND s."soldAt" >= ${paceStart}::timestamptz
              AND s."status" IN ('COMPLETED', 'REFUNDED')
          ), 0)::int AS "returned"
      ) sold
      LEFT JOIN LATERAL (
        SELECT b."supplierId", sup."name" AS "supplierName", b."costPrice", b."createdAt" AS "receivedAt"
        FROM "Batch" b JOIN "Supplier" sup ON sup."id" = b."supplierId"
        WHERE b."medicineId" = low."id"
        ORDER BY b."createdAt" DESC, b."id" DESC
        LIMIT 1
      ) lb ON TRUE
      ORDER BY low."sellable", low."name", low."id"`,
  ]);

  return {
    items: rows.map((r) => {
      const soldLast30Days = r.sold - r.returned;
      return {
        medicine: {
          id: r.id,
          name: r.name,
          genericName: r.genericName,
          unit: r.unit,
          category: r.category,
          reorderLevel: r.reorderLevel,
        },
        sellableQuantity: r.sellable,
        expiredQuantity: r.expired,
        shortBy: Math.max(r.reorderLevel - r.sellable, 0),
        soldLast30Days,
        daysOfCover: daysOfCover(r.sellable, soldLast30Days, PACE_DAYS),
        lastSupplier: r.supplierId ? { id: r.supplierId, name: r.supplierName! } : null,
        lastCostPrice: r.costPrice?.toFixed(2) ?? null,
        lastReceivedAt: r.receivedAt?.toISOString() ?? null,
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ─── Supplier purchases ─────────────────────────────────────────────────────

const MAX_PURCHASE_LINES = 5_000;

/**
 * Stock received (PURCHASE movements) from..to, per supplier, valued at the
 * batches' cost prices. For one supplier, also every batch received.
 */
export async function supplierPurchasesReport(
  query: SupplierPurchasesQuery,
): Promise<SupplierPurchasesReportDto> {
  const { from, to } = checkedRange(query);
  const { start, end } = bounds(from, to);
  const supplier = query.supplierId
    ? Prisma.sql`AND b."supplierId" = ${query.supplierId}::uuid`
    : Prisma.empty;
  const receivedWhere = Prisma.sql`
    WHERE sm."type" = 'PURCHASE'
      AND sm."createdAt" >= ${start}::timestamptz AND sm."createdAt" < ${end}::timestamptz
      ${supplier}`;

  const suppliers = await prisma.$queryRaw<
    {
      id: string;
      name: string;
      batches: number;
      medicines: number;
      units: number;
      value: Prisma.Decimal;
      lastReceivedAt: Date;
    }[]
  >`
    SELECT sup."id", sup."name", t.*
    FROM (
      SELECT b."supplierId",
        count(DISTINCT b."id")::int AS "batches",
        count(DISTINCT b."medicineId")::int AS "medicines",
        SUM(sm."quantity")::int AS "units",
        SUM(sm."quantity" * b."costPrice") AS "value",
        MAX(sm."createdAt") AS "lastReceivedAt"
      FROM "StockMovement" sm
      JOIN "Batch" b ON b."id" = sm."batchId"
      ${receivedWhere}
      GROUP BY b."supplierId"
    ) t
    JOIN "Supplier" sup ON sup."id" = t."supplierId"
    ORDER BY t."value" DESC, sup."name", sup."id"`;

  let lines: SupplierPurchasesReportDto['lines'] = null;
  if (query.supplierId) {
    const rows = await prisma.$queryRaw<
      {
        receivedAt: Date;
        reason: string | null;
        quantity: number;
        batchId: string;
        batchNumber: string;
        expiryDate: Date;
        costPrice: Prisma.Decimal;
        medicineId: string;
        name: string;
        genericName: string | null;
        unit: string;
        category: string;
      }[]
    >`
      SELECT sm."createdAt" AS "receivedAt", sm."reason", sm."quantity",
        b."id" AS "batchId", b."batchNumber", b."expiryDate", b."costPrice",
        m."id" AS "medicineId", m."name", m."genericName", m."unit", c."name" AS "category"
      FROM "StockMovement" sm
      JOIN "Batch" b ON b."id" = sm."batchId"
      JOIN "Medicine" m ON m."id" = b."medicineId"
      JOIN "Category" c ON c."id" = m."categoryId"
      ${receivedWhere}
      ORDER BY sm."createdAt" DESC, m."name", sm."id"
      LIMIT ${MAX_PURCHASE_LINES}`;
    lines = rows.map((r) => ({
      receivedAt: r.receivedAt.toISOString(),
      medicine: {
        id: r.medicineId,
        name: r.name,
        genericName: r.genericName,
        unit: r.unit,
        category: r.category,
      },
      batch: { id: r.batchId, batchNumber: r.batchNumber, expiryDate: toDateOnly(r.expiryDate) },
      reference: r.reason,
      quantity: r.quantity,
      costPrice: r.costPrice.toFixed(2),
      value: formatPaisa(paisa(r.costPrice) * BigInt(r.quantity)),
    }));
  }

  let value = 0n;
  for (const s of suppliers) value += paisa(s.value);
  return {
    from,
    to,
    totals: {
      suppliers: suppliers.length,
      batches: suppliers.reduce((sum, s) => sum + s.batches, 0),
      units: suppliers.reduce((sum, s) => sum + s.units, 0),
      value: formatPaisa(value),
    },
    suppliers: suppliers.map((s) => ({
      supplier: { id: s.id, name: s.name },
      batches: s.batches,
      medicines: s.medicines,
      units: s.units,
      value: money(s.value),
      lastReceivedAt: s.lastReceivedAt.toISOString(),
    })),
    lines,
  };
}

// ─── Cashiers ───────────────────────────────────────────────────────────────

type MethodRow = { userId: string; method: PaymentMethod; amount: Prisma.Decimal };

function methodAmounts(rows: MethodRow[], userId?: string) {
  const sums: Record<PaymentMethod, Paisa> = { CASH: 0n, CARD: 0n, MOBILE_WALLET: 0n };
  for (const r of rows) if (!userId || r.userId === userId) sums[r.method] += paisa(r.amount);
  return {
    CASH: formatPaisa(sums.CASH),
    CARD: formatPaisa(sums.CARD),
    MOBILE_WALLET: formatPaisa(sums.MOBILE_WALLET),
  };
}

async function usersById(ids: string[]): Promise<Map<string, SaleUserRef>> {
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, username: true, fullName: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

/** Each cashier's sales from..to: counted figures, refunds against them, voids and payment mix. */
export async function cashierReport(query: ReportRangeQuery): Promise<CashierReportDto> {
  const { from, to } = checkedRange(query);
  const { start, end } = bounds(from, to);

  const [sumRows, voidRows, paymentRows] = await prisma.$transaction([
    prisma.$queryRaw<(SumRow & { userId: string })[]>`
      WITH ${salesCte(start, end)}, ${saleCostCtes}
      SELECT sales."cashierId" AS "userId", ${sumColumns}
      ${salesFrom}
      GROUP BY sales."cashierId"`,
    prisma.$queryRaw<{ userId: string; count: number; total: Prisma.Decimal }[]>`
      SELECT s."cashierId" AS "userId", count(*)::int AS "count", SUM(s."grandTotal") AS "total"
      FROM "Sale" s
      WHERE s."soldAt" >= ${start}::timestamptz AND s."soldAt" < ${end}::timestamptz
        AND s."status" = 'VOIDED'
      GROUP BY s."cashierId"`,
    prisma.$queryRaw<MethodRow[]>`
      WITH ${salesCte(start, end)}
      SELECT sales."cashierId" AS "userId", p."method", SUM(p."amount") AS "amount"
      FROM sales JOIN "Payment" p ON p."saleId" = sales."id"
      GROUP BY sales."cashierId", p."method"`,
  ]);

  const voids = new Map(voidRows.map((v) => [v.userId, v]));
  const users = await usersById([
    ...sumRows.map((r) => r.userId),
    ...voidRows.map((r) => r.userId),
  ]);
  const sums = new Map(sumRows.map((r) => [r.userId, r]));
  const row = (userId?: string): Omit<CashierSalesRowDto, 'cashier'> => {
    const picked = userId ? [sums.get(userId)].filter((r) => r !== undefined) : sumRows;
    const total = picked.map(toSums).reduce(addSums, ZERO_SUMS);
    const units = picked.reduce((n, r) => n + r.units, 0);
    const voided = userId ? [voids.get(userId)].filter((v) => v !== undefined) : voidRows;
    const { revenue } = profitOf(total);
    return {
      saleCount: total.saleCount,
      unitsSold: units,
      grossSales: formatPaisa(total.grossSales),
      discounts: formatPaisa(total.discounts),
      netSales: formatPaisa(total.netSales),
      refunds: formatPaisa(total.refunds),
      revenue: formatPaisa(revenue),
      averageBill: average(total.netSales, total.saleCount),
      voidedCount: voided.reduce((n, v) => n + v.count, 0),
      voidedTotal: formatPaisa(voided.reduce((n, v) => n + paisa(v.total), 0n)),
      payments: methodAmounts(paymentRows, userId),
    };
  };

  const cashiers = [...users.values()]
    .map((cashier) => ({ cashier, ...row(cashier.id) }))
    .sort((a, b) => {
      const diff = toPaisa(b.netSales) - toPaisa(a.netSales);
      return diff !== 0n
        ? diff > 0n
          ? 1
          : -1
        : a.cashier.fullName.localeCompare(b.cashier.fullName);
    });
  return { from, to, totals: row(), cashiers };
}

// ─── Cash closing ───────────────────────────────────────────────────────────

/**
 * The drawer for one business day: money taken on every sale rung up that
 * day (including ones voided since: the money did come in), less money paid
 * back for sales voided that day and returns refunded that day, whichever
 * day those were sold. A closed day's figures therefore never change.
 * Attributed to whoever handled the money: the cashier for a sale, whoever
 * voided it, whoever raised the return.
 */
export async function cashClosingReport(query: CashClosingQuery): Promise<CashClosingReportDto> {
  const date = query.date ?? businessToday();
  const { start, end } = bounds(date, date);
  const inDay = (column: Prisma.Sql) =>
    Prisma.sql`${column} >= ${start}::timestamptz AND ${column} < ${end}::timestamptz`;

  type CountRow = { userId: string; count: number };
  const [
    saleCounts,
    salePayments,
    cashRow,
    voidCounts,
    voidPayments,
    refundCounts,
    refundAmounts,
    [pending],
    [conflicts],
  ] = await prisma.$transaction([
    prisma.$queryRaw<CountRow[]>`
      SELECT s."cashierId" AS "userId", count(*)::int AS "count"
      FROM "Sale" s WHERE ${inDay(Prisma.sql`s."soldAt"`)}
      GROUP BY s."cashierId"`,
    prisma.$queryRaw<MethodRow[]>`
      SELECT s."cashierId" AS "userId", p."method", SUM(p."amount") AS "amount"
      FROM "Sale" s JOIN "Payment" p ON p."saleId" = s."id"
      WHERE ${inDay(Prisma.sql`s."soldAt"`)}
      GROUP BY s."cashierId", p."method"`,
    prisma.$queryRaw<[{ tendered: Prisma.Decimal | null; change: Prisma.Decimal | null }]>`
      SELECT
        (SELECT SUM(COALESCE(p."tendered", p."amount")) FROM "Sale" s
          JOIN "Payment" p ON p."saleId" = s."id" AND p."method" = 'CASH'
          WHERE ${inDay(Prisma.sql`s."soldAt"`)}) AS "tendered",
        (SELECT SUM(s."changeDue") FROM "Sale" s WHERE ${inDay(Prisma.sql`s."soldAt"`)}) AS "change"`,
    prisma.$queryRaw<CountRow[]>`
      SELECT s."voidedById" AS "userId", count(*)::int AS "count"
      FROM "Sale" s WHERE s."status" = 'VOIDED' AND ${inDay(Prisma.sql`s."voidedAt"`)}
      GROUP BY s."voidedById"`,
    prisma.$queryRaw<MethodRow[]>`
      SELECT s."voidedById" AS "userId", p."method", SUM(p."amount") AS "amount"
      FROM "Sale" s JOIN "Payment" p ON p."saleId" = s."id"
      WHERE s."status" = 'VOIDED' AND ${inDay(Prisma.sql`s."voidedAt"`)}
      GROUP BY s."voidedById", p."method"`,
    prisma.$queryRaw<CountRow[]>`
      SELECT r."requestedById" AS "userId", count(*)::int AS "count"
      FROM "Return" r WHERE r."status" = 'COMPLETED' AND ${inDay(Prisma.sql`r."reviewedAt"`)}
      GROUP BY r."requestedById"`,
    prisma.$queryRaw<MethodRow[]>`
      SELECT r."requestedById" AS "userId", rr."method", SUM(rr."amount") AS "amount"
      FROM "Return" r JOIN "ReturnRefund" rr ON rr."returnId" = r."id"
      WHERE r."status" = 'COMPLETED' AND ${inDay(Prisma.sql`r."reviewedAt"`)}
      GROUP BY r."requestedById", rr."method"`,
    prisma.$queryRaw<[{ count: number; total: Prisma.Decimal | null }]>`
      SELECT count(*)::int AS "count", SUM("refundTotal") AS "total"
      FROM "Return" WHERE "status" = 'PENDING'`,
    prisma.$queryRaw<[{ count: number; total: Prisma.Decimal | null }]>`
      SELECT count(*)::int AS "count", SUM("expectedTotal") AS "total"
      FROM "OfflineSaleConflict" c
      WHERE c."status" = 'OPEN' AND ${inDay(Prisma.sql`c."soldAt"`)}`,
  ]);

  const flow = (counts: CountRow[], amounts: MethodRow[]): FlowInput => ({
    counts,
    amounts: amounts.map((a) => ({ userId: a.userId, method: a.method, amount: paisa(a.amount) })),
  });
  const users = await usersById(
    [saleCounts, voidCounts, refundCounts].flatMap((rows) => rows.map((r) => r.userId)),
  );
  const closing = buildCashClosing({
    sales: flow(saleCounts, salePayments),
    voids: flow(voidCounts, voidPayments),
    refunds: flow(refundCounts, refundAmounts),
    users,
  });

  return {
    date,
    generatedAt: new Date().toISOString(),
    ...closing,
    sales: {
      ...closing.sales,
      cashTendered: money(cashRow[0].tendered),
      changeGiven: money(cashRow[0].change),
    },
    pendingReturns: { count: pending.count, refundTotal: money(pending.total) },
    openOfflineConflicts: { count: conflicts.count, expectedTotal: money(conflicts.total) },
  };
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

const TREND_DAYS = 30;
const DASHBOARD_BEST_SELLERS = 5;

/** Counts behind the stock cards; same rules as the alerts job and inventory lists. */
async function stockCounts(today: string) {
  const expiringUntil = addDays(today, config.ALERT_EXPIRY_DAYS);
  const [[medicines], [batches]] = await prisma.$transaction([
    prisma.$queryRaw<[{ lowStock: number; outOfStock: number }]>`
      SELECT
        count(*) FILTER (WHERE s."sellable" > 0)::int AS "lowStock",
        count(*) FILTER (WHERE s."sellable" <= 0)::int AS "outOfStock"
      FROM "Medicine" m
      CROSS JOIN LATERAL (${medicineStockTotalsSql(today)}) s
      WHERE m."status" = 'ACTIVE' AND s."sellable" <= m."reorderLevel"
        AND EXISTS (SELECT 1 FROM "Batch" b WHERE b."medicineId" = m."id")`,
    prisma.$queryRaw<[{ expiringSoon: number; expiredOnShelf: number }]>`
      SELECT
        count(*) FILTER (WHERE b."expiryDate" > ${today}::date)::int AS "expiringSoon",
        count(*) FILTER (WHERE b."expiryDate" <= ${today}::date)::int AS "expiredOnShelf"
      FROM "Batch" b
      WHERE b."expiryDate" <= ${expiringUntil}::date AND ${batchQuantitySql} > 0`,
  ]);
  return { ...medicines, ...batches, expiringDays: config.ALERT_EXPIRY_DAYS };
}

/** Today at a glance: sales and profit, the last 30 days, best sellers and what needs attention. */
export async function dashboard(): Promise<DashboardDto> {
  const today = businessToday();
  const trendFrom = addDays(today, -(TREND_DAYS - 1));
  const monthStart = periodStart(today, 'month');
  const { start, end } = bounds(today, today);

  const [trend, month, best, paymentRows, stock, counts] = await Promise.all([
    salesPeriods(trendFrom, today, 'day'),
    salesPeriods(monthStart, today, 'month'),
    medicineReport({
      from: trendFrom,
      to: today,
      sort: 'revenue',
      page: 1,
      pageSize: DASHBOARD_BEST_SELLERS,
      format: 'json',
    }),
    prisma.$queryRaw<{ method: PaymentMethod; count: number; amount: Prisma.Decimal }[]>`
      SELECT p."method", count(DISTINCT s."id")::int AS "count", SUM(p."amount") AS "amount"
      FROM "Sale" s JOIN "Payment" p ON p."saleId" = s."id"
      WHERE s."soldAt" >= ${start}::timestamptz AND s."soldAt" < ${end}::timestamptz
        AND s."status" IN ('COMPLETED', 'REFUNDED')
      GROUP BY p."method"`,
    stockCounts(today),
    prisma.$transaction([
      prisma.return.count({ where: { status: 'PENDING' } }),
      prisma.offlineSaleConflict.count({ where: { status: 'OPEN' } }),
      prisma.alert.count({ where: { resolvedAt: null, acknowledgedAt: null } }),
    ]),
  ]);

  const byMethod = new Map(paymentRows.map((p) => [p.method, p]));
  const paymentsToday: PaymentMixDto[] = (['CASH', 'CARD', 'MOBILE_WALLET'] as const).map(
    (method) => ({
      method,
      count: byMethod.get(method)?.count ?? 0,
      amount: money(byMethod.get(method)?.amount),
    }),
  );
  const day = (date: string) => {
    const found = trend.periods.find((p) => p.period === date);
    const { period: _period, ...metrics } = found ?? { period: date, ...toMetrics(ZERO_SUMS) };
    return metrics;
  };

  return {
    businessDate: today,
    today: day(today),
    yesterday: day(addDays(today, -1)),
    monthToDate: toMetrics(month.totals),
    trend: trend.periods,
    bestSellers: best.items,
    paymentsToday,
    stock,
    pendingReturns: counts[0],
    openOfflineConflicts: counts[1],
    unreadAlerts: counts[2],
  };
}
