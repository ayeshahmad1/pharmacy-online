import { z } from 'zod';
import type { OfflineConflictStatus } from '../constants';
import { OFFLINE_CONFLICT_STATUSES } from '../constants';
import { paginationQuerySchema } from './common';
import type { CreateSaleBody, SaleUserRef } from './sales';
import { createSaleBodySchema } from './sales';

// Offline billing: the catalogue the counter keeps on the device, and sales
// the API refused when the device synced them, kept for review.

// ─── Catalogue snapshot ─────────────────────────────────────────────────────

/** A batch with stock on hand. Expired ones are included so the counter can tell "expired" from "out". */
export type OfflineBatchDto = {
  id: string;
  batchNumber: string;
  /** "YYYY-MM-DD". Expired from this date onward. */
  expiryDate: string;
  quantity: number;
};

export type OfflineMedicineDto = {
  id: string;
  name: string;
  genericName: string | null;
  barcode: string | null;
  unit: string;
  /** PKR per unit, e.g. "120.50". */
  sellingPrice: string;
  reorderLevel: number;
  /** Batches with stock, in the order FEFO sells them (earliest expiry first). */
  batches: OfflineBatchDto[];
};

/**
 * Everything billing needs to keep selling without the server: every active
 * medicine with its batches, and the rules the API will apply at sync.
 */
export type OfflineCatalogueDto = {
  generatedAt: string;
  /** "YYYY-MM-DD" in the pharmacy's timezone when the snapshot was taken. */
  businessDate: string;
  /** IANA timezone that decides what day it is for expiry checks. */
  timeZone: string;
  cashierMaxDiscountPercent: number;
  /** Offline sales older than this are refused at sync. */
  offlineSaleMaxAgeDays: number;
  medicines: OfflineMedicineDto[];
};

// ─── Conflicts ──────────────────────────────────────────────────────────────

const reasonSchema = z.string().trim().min(3, 'Give a reason').max(500);

/**
 * A device reporting an offline sale the API refused at sync. The sale is
 * stored as sent, with the API's answer, for a pharmacist or admin to retry
 * or dismiss. Reporting the same sale again returns the first report.
 */
export const reportOfflineConflictBodySchema = z.strictObject({
  sale: createSaleBodySchema.refine((s) => s.offline !== undefined, {
    message: 'Only offline sales can be reported',
    path: ['offline'],
  }),
  error: z.strictObject({
    code: z.string().trim().min(1).max(50),
    message: z.string().trim().min(1).max(1000),
    details: z.unknown().optional(),
  }),
});
export type ReportOfflineConflictBody = z.infer<typeof reportOfflineConflictBodySchema>;

export const listOfflineConflictsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(OFFLINE_CONFLICT_STATUSES).optional(),
});
export type ListOfflineConflictsQuery = z.infer<typeof listOfflineConflictsQuerySchema>;

/**
 * Saves the sale as recorded, for its original cashier and time. The
 * reviewer's approval lifts the cashier discount cap. With
 * `acceptCurrentPrices` the catalogue's current prices are charged even if
 * they differ from what the customer was charged offline.
 */
export const retryOfflineConflictBodySchema = z.strictObject({
  acceptCurrentPrices: z.boolean().default(false),
});
export type RetryOfflineConflictBody = z.infer<typeof retryOfflineConflictBodySchema>;

export const dismissOfflineConflictBodySchema = z.strictObject({ reason: reasonSchema });
export type DismissOfflineConflictBody = z.infer<typeof dismissOfflineConflictBodySchema>;

export type OfflineConflictItemDto = {
  medicineId: string;
  /** Null if the medicine no longer exists. */
  name: string | null;
  unit: string | null;
  quantity: number;
};

export type OfflineSaleConflictDto = {
  id: string;
  idempotencyKey: string;
  status: OfflineConflictStatus;
  cashier: SaleUserRef;
  /** When the sale happened at the counter. */
  soldAt: string;
  /** What the customer was charged offline. */
  expectedTotal: string;
  items: OfflineConflictItemDto[];
  /** The sale exactly as the device sent it. */
  request: CreateSaleBody;
  /** Why the API refused it the last time it was tried. */
  error: { code: string; message: string; details: unknown };
  attempts: number;
  reportedAt: string;
  lastAttemptAt: string;
  /** Set once a retry saved it. */
  sale: { id: string; receiptNumber: string } | null;
  resolvedBy: SaleUserRef | null;
  resolvedAt: string | null;
  dismissReason: string | null;
};
