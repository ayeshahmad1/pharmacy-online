import { z } from 'zod';
import type { PaymentMethod } from '../constants';
import { paginationQuerySchema, searchTermSchema } from './common';
import { dateOnlySchema } from './inventory';
import type { SaleUserRef } from './sales';

// Reports and the dashboard. Every date is a business day ("YYYY-MM-DD") in
// the pharmacy's timezone, and ranges include both ends. Sales count on the
// day they were made at the counter (Sale.soldAt); voided sales are left
// out; refunds of completed returns are taken off the day of the original
// sale, so a day's revenue can drop when something it sold is returned later.
// The cash-closing report is the exception: it follows the drawer, so voids
// and refunds count on the day the money went back.

/** Longest range any report accepts (about five years). */
export const MAX_REPORT_DAYS = 1830;
/** Longest range the day-by-day sales report accepts. */
export const MAX_DAILY_REPORT_DAYS = 400;
/** Range used when a report is asked for without dates: the last 30 days, today included. */
export const DEFAULT_REPORT_DAYS = 30;

export const REPORT_GROUP_BYS = ['day', 'week', 'month'] as const;
export type ReportGroupBy = (typeof REPORT_GROUP_BYS)[number];

/** `csv` downloads the whole report (every page) as a spreadsheet file. */
const formatSchema = z.enum(['json', 'csv']).default('json');
export type ReportFormat = z.infer<typeof formatSchema>;

/** Whole days from one "YYYY-MM-DD" to another, both included. */
export function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

const rangeShape = {
  /** First day, inclusive. Defaults to 29 days before `to`. */
  from: dateOnlySchema.optional(),
  /** Last day, inclusive. Defaults to today. */
  to: dateOnlySchema.optional(),
  format: formatSchema,
};

type Range = { from?: string; to?: string };

function checkRange(q: Range, ctx: z.RefinementCtx, maxDays = MAX_REPORT_DAYS) {
  if (!q.from || !q.to) return;
  if (q.from > q.to) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: '"from" must not be after "to"' });
  } else if (rangeDays(q.from, q.to) > maxDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: `Choose a range of at most ${maxDays} days`,
    });
  }
}

export const reportRangeQuerySchema = z
  .object(rangeShape)
  .superRefine((q, ctx) => checkRange(q, ctx));
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;

export const salesReportQuerySchema = z
  .object({ ...rangeShape, groupBy: z.enum(REPORT_GROUP_BYS).default('day') })
  .superRefine((q, ctx) =>
    checkRange(q, ctx, q.groupBy === 'day' ? MAX_DAILY_REPORT_DAYS : MAX_REPORT_DAYS),
  );
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;

export const MEDICINE_REPORT_SORTS = ['revenue', 'profit', 'margin', 'units', 'name'] as const;
export type MedicineReportSort = (typeof MEDICINE_REPORT_SORTS)[number];

/** Profit and margin per medicine; sorted by units or revenue it is the best-sellers list. */
export const medicineReportQuerySchema = paginationQuerySchema
  .extend({
    ...rangeShape,
    q: searchTermSchema.optional(),
    categoryId: z.uuid().optional(),
    sort: z.enum(MEDICINE_REPORT_SORTS).default('revenue'),
  })
  .superRefine((q, ctx) => checkRange(q, ctx));
export type MedicineReportQuery = z.infer<typeof medicineReportQuerySchema>;

export const deadStockQuerySchema = paginationQuerySchema.extend({
  /** No sale for at least this many days. Defaults to the server's DEAD_STOCK_DAYS. */
  days: z.coerce.number().int().min(7).max(730).optional(),
  categoryId: z.uuid().optional(),
  format: formatSchema,
});
export type DeadStockQuery = z.infer<typeof deadStockQuerySchema>;

export const expiryReportQuerySchema = paginationQuerySchema.extend({
  /** Batches expiring within this many days, plus every expired batch still in stock. Defaults to EXPIRY_WARNING_DAYS. */
  days: z.coerce.number().int().min(1).max(730).optional(),
  format: formatSchema,
});
export type ExpiryReportQuery = z.infer<typeof expiryReportQuerySchema>;

export const lowStockReportQuerySchema = paginationQuerySchema.extend({
  categoryId: z.uuid().optional(),
  format: formatSchema,
});
export type LowStockReportQuery = z.infer<typeof lowStockReportQuerySchema>;

export const supplierPurchasesQuerySchema = z
  .object({ ...rangeShape, supplierId: z.uuid().optional() })
  .superRefine((q, ctx) => checkRange(q, ctx));
export type SupplierPurchasesQuery = z.infer<typeof supplierPurchasesQuerySchema>;

export const cashClosingQuerySchema = z.object({
  /** Defaults to today. */
  date: dateOnlySchema.optional(),
  format: formatSchema,
});
export type CashClosingQuery = z.infer<typeof cashClosingQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────
// Money is a PKR decimal string with 2 decimal places. Percentages are
// strings with 2 decimal places too, e.g. "23.50", and null when undefined
// (no revenue to divide by).

/** One PKR amount per payment method. */
export type MethodAmounts = Record<PaymentMethod, string>;

export type SalesMetricsDto = {
  saleCount: number;
  /** Before discounts (Σ subtotal). */
  grossSales: string;
  discounts: string;
  /** What customers paid (Σ grand total). */
  netSales: string;
  /** Refunds of completed returns against these sales, whenever they happened. */
  refunds: string;
  /** netSales − refunds. */
  revenue: string;
  /** Cost of the units sold, less units that went back on the shelf from returns. */
  cost: string;
  /** revenue − cost. */
  grossProfit: string;
  /** grossProfit ÷ revenue. */
  marginPercent: string | null;
  /** netSales ÷ saleCount. */
  averageBill: string | null;
};

export type SalesPeriodDto = SalesMetricsDto & {
  /** First day of the period: the day itself, the Monday of the week, or the 1st of the month. */
  period: string;
};

export type SalesReportDto = {
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  totals: SalesMetricsDto;
  /** Every period in the range, oldest first, including ones with no sales. */
  periods: SalesPeriodDto[];
};

export type ReportMedicineRef = {
  id: string;
  name: string;
  genericName: string | null;
  unit: string;
  category: string;
};

export type MedicineSalesDto = {
  medicine: ReportMedicineRef;
  unitsSold: number;
  unitsReturned: number;
  netUnits: number;
  netSales: string;
  refunds: string;
  revenue: string;
  cost: string;
  grossProfit: string;
  marginPercent: string | null;
};

export type MedicineReportDto = {
  from: string;
  to: string;
  sort: MedicineReportSort;
  totals: Omit<MedicineSalesDto, 'medicine'> & { medicines: number };
  items: MedicineSalesDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type DeadStockDto = {
  medicine: ReportMedicineRef & { sellingPrice: string };
  sellableQuantity: number;
  /** Sellable stock valued at each batch's cost price. */
  costValue: string;
  /** Sellable stock valued at today's selling price. */
  retailValue: string;
  lastSoldAt: string | null;
  /** When the oldest batch still holding sellable stock arrived. */
  oldestStockReceivedAt: string;
};

export type DeadStockReportDto = {
  days: number;
  /** No sales on or after this instant. */
  since: string;
  totals: { medicines: number; units: number; costValue: string; retailValue: string };
  items: DeadStockDto[];
  total: number;
  page: number;
  pageSize: number;
};

export const EXPIRY_BUCKETS = ['EXPIRED', 'DAYS_30', 'DAYS_60', 'DAYS_90', 'LATER'] as const;
export type ExpiryBucket = (typeof EXPIRY_BUCKETS)[number];

export type ExpiryRowDto = {
  batch: { id: string; batchNumber: string; expiryDate: string };
  medicine: ReportMedicineRef;
  supplier: { id: string; name: string };
  quantity: number;
  daysToExpiry: number;
  isExpired: boolean;
  bucket: ExpiryBucket;
  costValue: string;
  retailValue: string;
};

export type ExpiryBucketTotalsDto = {
  bucket: ExpiryBucket;
  batches: number;
  units: number;
  costValue: string;
  retailValue: string;
};

export type ExpiryReportDto = {
  today: string;
  days: number;
  /** Batches expiring on or before this day are listed (plus every expired one). */
  until: string;
  /** Only buckets the window reaches, in order. */
  buckets: ExpiryBucketTotalsDto[];
  items: ExpiryRowDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type LowStockRowDto = {
  medicine: ReportMedicineRef & { reorderLevel: number };
  sellableQuantity: number;
  /** Expired units still on the shelf: not sellable, to be written off. */
  expiredQuantity: number;
  /** reorderLevel − sellable, at least 0. */
  shortBy: number;
  /** Units sold in the last 30 days, less units returned to stock. */
  soldLast30Days: number;
  /** Days the sellable stock lasts at the last 30 days' pace; null when nothing sold. */
  daysOfCover: number | null;
  lastSupplier: { id: string; name: string } | null;
  lastCostPrice: string | null;
  lastReceivedAt: string | null;
};

export type LowStockReportDto = {
  items: LowStockRowDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type SupplierPurchasesRowDto = {
  supplier: { id: string; name: string };
  batches: number;
  medicines: number;
  units: number;
  /** Σ quantity × cost price. */
  value: string;
  lastReceivedAt: string;
};

export type SupplierPurchaseLineDto = {
  receivedAt: string;
  medicine: ReportMedicineRef;
  batch: { id: string; batchNumber: string; expiryDate: string };
  /** "Invoice …" as entered at receipt, if any. */
  reference: string | null;
  quantity: number;
  costPrice: string;
  value: string;
};

export type SupplierPurchasesReportDto = {
  from: string;
  to: string;
  totals: { suppliers: number; batches: number; units: number; value: string };
  suppliers: SupplierPurchasesRowDto[];
  /** Each batch received, newest first, when the report is for one supplier. */
  lines: SupplierPurchaseLineDto[] | null;
};

export type CashierSalesRowDto = {
  cashier: SaleUserRef;
  saleCount: number;
  unitsSold: number;
  grossSales: string;
  discounts: string;
  netSales: string;
  refunds: string;
  revenue: string;
  averageBill: string | null;
  /** This cashier's sales in the range that were voided (not in the figures above). */
  voidedCount: number;
  voidedTotal: string;
  /** How their (not voided) sales were paid. */
  payments: MethodAmounts;
};

export type CashierReportDto = {
  from: string;
  to: string;
  totals: Omit<CashierSalesRowDto, 'cashier'>;
  cashiers: CashierSalesRowDto[];
};

export type CashFlowDto = {
  count: number;
  byMethod: MethodAmounts;
  total: string;
};

/** One person's part of the day: sales they rang up, voids they did, refunds they handed out. */
export type CashClosingPersonDto = {
  user: SaleUserRef;
  sales: CashFlowDto;
  voids: CashFlowDto;
  refunds: CashFlowDto;
  net: MethodAmounts;
  expectedCash: string;
};

export type CashClosingReportDto = {
  date: string;
  generatedAt: string;
  /** Every sale rung up that day, including any voided since (the money came in). */
  sales: CashFlowDto & { cashTendered: string; changeGiven: string };
  /** Sales voided that day, whichever day they were made: paid back in full. */
  voids: CashFlowDto;
  /** Completed returns refunded that day, whichever day they were sold. */
  refunds: CashFlowDto;
  /** sales − voids − refunds, per method. */
  net: MethodAmounts;
  /** Cash that should be in the drawer from the day's business (excludes any opening float). */
  expectedCash: string;
  people: CashClosingPersonDto[];
  /** Returns waiting for approval now; their refunds are not in the figures yet. */
  pendingReturns: { count: number; refundTotal: string };
  /** Offline sales from that day refused at sync and still open: charged at the counter but not recorded as sales. */
  openOfflineConflicts: { count: number; expectedTotal: string };
};

export type PaymentMixDto = { method: PaymentMethod; count: number; amount: string };

export type DashboardDto = {
  businessDate: string;
  today: SalesMetricsDto;
  yesterday: SalesMetricsDto;
  monthToDate: SalesMetricsDto;
  /** The last 30 days, day by day, today included. */
  trend: SalesPeriodDto[];
  /** Top medicines by revenue over the last 30 days. */
  bestSellers: MedicineSalesDto[];
  paymentsToday: PaymentMixDto[];
  stock: {
    lowStock: number;
    outOfStock: number;
    expiringSoon: number;
    expiringDays: number;
    expiredOnShelf: number;
  };
  pendingReturns: number;
  openOfflineConflicts: number;
  unreadAlerts: number;
};
