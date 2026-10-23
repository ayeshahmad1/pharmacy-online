import { z } from 'zod';
import type { RecordStatus, StockMovementType } from '../constants';
import { STOCK_MOVEMENT_TYPES } from '../constants';
import {
  moneySchema,
  optionalTextSchema,
  paginationQuerySchema,
  recordStatusSchema,
  searchTermSchema,
} from './common';

/** A calendar date with no time or timezone, e.g. "2027-06-30". */
export const dateOnlySchema = z.iso.date('Must be a date like "2027-06-30"');

/**
 * Manufacturer's batch/lot number as printed on the pack. Stored uppercase so
 * "pn-2401" and "PN-2401" are recognised as the same lot.
 */
const batchNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Batch number is required')
  .max(50)
  .regex(/^[\x21-\x7E]+$/, 'Batch number may only contain letters, digits and symbols, no spaces');

/** Stock quantities are whole units of the medicine's `unit`. */
const MAX_QUANTITY = 1_000_000;

const receiveStockItemSchema = z.strictObject({
  medicineId: z.uuid(),
  batchNumber: batchNumberSchema,
  /** Must be after today (in the pharmacy's timezone); checked by the API. */
  expiryDate: dateOnlySchema,
  /** Cost per `unit` of the medicine, PKR, as a decimal string. */
  costPrice: moneySchema,
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(MAX_QUANTITY),
});
export type ReceiveStockItem = z.infer<typeof receiveStockItemSchema>;

/** One delivery from one supplier. Each line becomes a new Batch with a PURCHASE movement. */
export const receiveStockBodySchema = z
  .strictObject({
    supplierId: z.uuid(),
    /** Supplier's invoice or delivery-note number, kept on the movements and audit log. */
    invoiceNumber: optionalTextSchema(100),
    items: z.array(receiveStockItemSchema).min(1, 'Add at least one item').max(200),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.items.forEach((item, i) => {
      const key = `${item.medicineId}|${item.batchNumber}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'batchNumber'],
          message: 'The same batch of this medicine appears twice; combine the lines',
        });
      }
      seen.add(key);
    });
  });
export type ReceiveStockBody = z.infer<typeof receiveStockBodySchema>;

/** Stock-count correction on one batch: positive adds stock, negative removes it. */
export const adjustStockBodySchema = z.strictObject({
  batchId: z.uuid(),
  quantity: z
    .number()
    .int()
    .min(-MAX_QUANTITY)
    .max(MAX_QUANTITY)
    .refine((q) => q !== 0, 'Quantity cannot be zero'),
  reason: z.string().trim().min(3, 'Give a reason for the adjustment').max(500),
});
export type AdjustStockBody = z.infer<typeof adjustStockBodySchema>;

/**
 * Writes off the full remaining stock of expired batches. Without `batchIds`,
 * every expired batch that still has stock is written off.
 */
export const writeOffExpiredBodySchema = z.strictObject({
  batchIds: z
    .array(z.uuid())
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Batch ids must be unique')
    .optional(),
  reason: optionalTextSchema(500),
});
export type WriteOffExpiredBody = z.infer<typeof writeOffExpiredBodySchema>;

const booleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const medicineStockQuerySchema = z.object({
  /** Also list batches that have run out. Default false. */
  includeEmpty: booleanQuerySchema,
});
export type MedicineStockQuery = z.infer<typeof medicineStockQuerySchema>;

export const listStockQuerySchema = paginationQuerySchema.extend({
  /** Matches brand or generic/salt name (case-insensitive substring). */
  q: searchTermSchema.optional(),
  categoryId: z.uuid().optional(),
  status: recordStatusSchema.optional(),
});
export type ListStockQuery = z.infer<typeof listStockQuerySchema>;

export const lowStockQuerySchema = paginationQuerySchema.extend({
  categoryId: z.uuid().optional(),
});
export type LowStockQuery = z.infer<typeof lowStockQuerySchema>;

export const expiringStockQuerySchema = paginationQuerySchema.extend({
  /** Window in days from today. Defaults to the server's EXPIRY_WARNING_DAYS. */
  days: z.coerce.number().int().min(1).max(730).optional(),
});
export type ExpiringStockQuery = z.infer<typeof expiringStockQuerySchema>;

export const expiredStockQuerySchema = paginationQuerySchema;
export type ExpiredStockQuery = z.infer<typeof expiredStockQuerySchema>;

export const listMovementsQuerySchema = paginationQuerySchema.extend({
  batchId: z.uuid().optional(),
  medicineId: z.uuid().optional(),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
});
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────

export type StockMedicineRef = {
  id: string;
  name: string;
  genericName: string | null;
  unit: string;
};

/** A batch with its current quantity, computed from its stock movements. */
export type BatchStockDto = {
  id: string;
  medicine: StockMedicineRef;
  supplier: { id: string; name: string };
  batchNumber: string;
  /** "YYYY-MM-DD". The batch is expired from this date onward. */
  expiryDate: string;
  isExpired: boolean;
  /** Days from today (pharmacy timezone) to expiry; 0 or less means expired. */
  daysToExpiry: number;
  /** Current stock on hand, in the medicine's unit. */
  quantity: number;
  quantityReceived: number;
  /** PKR per unit. Null for roles that may not see purchase prices (cashiers). */
  costPrice: string | null;
  receivedAt: string;
};

/** Stock totals for one medicine, computed from movements. */
export type StockSummaryDto = {
  medicine: StockMedicineRef & {
    barcode: string | null;
    reorderLevel: number;
    status: RecordStatus;
  };
  /** Stock in non-expired batches: what billing can sell. */
  sellableQuantity: number;
  /** Stock still on the shelf in expired batches, waiting for write-off. */
  expiredQuantity: number;
  totalQuantity: number;
  /** Sellable stock is at or below the reorder level. */
  isLowStock: boolean;
  /** Earliest expiry among non-expired batches that still have stock. */
  nextExpiry: string | null;
};

export type MedicineStockDto = StockSummaryDto & {
  /** Earliest expiry first (the order FEFO sells them in). */
  batches: BatchStockDto[];
};

export type StockMovementDto = {
  id: string;
  type: StockMovementType;
  /** Signed: positive added stock, negative removed it. */
  quantity: number;
  reason: string | null;
  batch: { id: string; batchNumber: string; medicine: { id: string; name: string } };
  user: { id: string; username: string; fullName: string };
  saleItemId: string | null;
  returnItemId: string | null;
  createdAt: string;
};

export type StockAdjustmentDto = {
  movement: StockMovementDto;
  quantityBefore: number;
  quantityAfter: number;
  batch: BatchStockDto;
};

export type ExpiredWriteOffDto = {
  items: { movement: StockMovementDto; batch: BatchStockDto; quantity: number }[];
  totalQuantity: number;
};

export type ExpiringStockDto = {
  items: BatchStockDto[];
  total: number;
  page: number;
  pageSize: number;
  /** The window that was applied, and its last day ("YYYY-MM-DD", inclusive). */
  days: number;
  expiringOnOrBefore: string;
};
