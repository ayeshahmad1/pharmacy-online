import { z } from 'zod';
import { paginationQuerySchema, searchTermSchema } from './common';
import { dateOnlySchema, type StockMedicineRef } from './inventory';
import type { SaleUserRef } from './sales';

// Records loaded from the old MongoDB system (CLAUDE.md rule 15). Read-only
// history: they never changed stock here, and returns stay out of reports.

const filters = {
  /** Medicine name or generic name, or part of it (case-insensitive). */
  q: searchTermSchema.optional(),
  medicineId: z.uuid().optional(),
  /** Days in the pharmacy's timezone, inclusive. */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
};

const fromNotAfterTo = (q: { from?: string; to?: string }) => !q.from || !q.to || q.from <= q.to;
const fromNotAfterToIssue = { message: '"from" must not be after "to"', path: ['from'] };

export const listLegacyPurchasesQuerySchema = paginationQuerySchema
  .extend({ ...filters, supplierId: z.uuid().optional() })
  .refine(fromNotAfterTo, fromNotAfterToIssue);
export type ListLegacyPurchasesQuery = z.infer<typeof listLegacyPurchasesQuerySchema>;

export const listLegacyReturnsQuerySchema = paginationQuerySchema
  .extend({ ...filters, cashierId: z.uuid().optional() })
  .refine(fromNotAfterTo, fromNotAfterToIssue);
export type ListLegacyReturnsQuery = z.infer<typeof listLegacyReturnsQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────
// All money is a PKR decimal string with 2 decimal places, e.g. "120.50".

export type LegacyBatchRef = { id: string; batchNumber: string; expiryDate: string };

/** One delivery the old system recorded. */
export type LegacyPurchaseDto = {
  id: string;
  purchasedAt: string;
  medicine: StockMedicineRef;
  batch: LegacyBatchRef;
  supplier: { id: string; name: string };
  quantity: number;
  /** What was paid for the whole delivery; null when the old system recorded no price. */
  totalCost: string | null;
  /** totalCost ÷ quantity, rounded half-up to the paisa. */
  unitCost: string | null;
};

export type LegacyReturnItemDto = {
  lineNo: number;
  medicine: StockMedicineRef;
  batch: LegacyBatchRef;
  quantity: number;
  unitPrice: string;
  discount: string;
  lineTotal: string;
};

/**
 * A return the old system recorded as a negative sale. It names no original
 * sale, so it is shown as history only and left out of every report.
 */
export type LegacyReturnDto = {
  id: string;
  returnedAt: string;
  cashier: SaleUserRef;
  refundTotal: string;
  /** Total units across all lines. */
  itemCount: number;
  items: LegacyReturnItemDto[];
};
