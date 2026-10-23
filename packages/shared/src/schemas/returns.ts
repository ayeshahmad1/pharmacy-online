import { z } from 'zod';
import type { PaymentMethod, ReturnStatus, SaleStatus } from '../constants';
import { PAYMENT_METHODS, RETURN_STATUSES } from '../constants';
import {
  optionalTextSchema,
  paginationQuerySchema,
  positiveMoneySchema,
  searchTermSchema,
} from './common';
import { dateOnlySchema } from './inventory';
import type { SaleItemDto, SaleUserRef } from './sales';

const reasonSchema = (what: string) =>
  z.string().trim().min(3, `Give a reason for ${what}`).max(500);

/**
 * One sale line (one batch) coming back. `restock: false` marks the units as
 * damaged or otherwise not fit to sell: they are refunded but stay out of
 * stock. Units whose batch has expired are never restocked, whatever is sent.
 */
const returnItemInputSchema = z.strictObject({
  saleItemId: z.uuid(),
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(10_000),
  restock: z.boolean().default(true),
});
export type ReturnItemInput = z.infer<typeof returnItemInputSchema>;

/**
 * How much goes back by one method. Only methods the sale was paid with are
 * allowed, each up to what was paid that way minus earlier refunds.
 */
const refundInputSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  amount: positiveMoneySchema,
  /** Card refund approval code or wallet transaction id. */
  reference: optionalTextSchema(100),
});
export type RefundInput = z.infer<typeof refundInputSchema>;

/**
 * A return against one sale. The API works out the refund from what the
 * customer paid for each line. A cashier's return waits for a pharmacist or
 * admin to approve it; theirs complete straight away.
 */
export const createReturnBodySchema = z
  .strictObject({
    saleId: z.uuid(),
    items: z.array(returnItemInputSchema).min(1, 'Add at least one item').max(100),
    reason: reasonSchema('the return'),
    /**
     * How to pay the refund back. Must add up to the refund total. Leave it
     * out to refund cash first, then card, then wallet, up to what each paid.
     */
    refunds: z.array(refundInputSchema).min(1).max(PAYMENT_METHODS.length).optional(),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.items.forEach((item, i) => {
      if (seen.has(item.saleItemId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'saleItemId'],
          message: 'This sale line appears twice; combine the quantities',
        });
      }
      seen.add(item.saleItemId);
    });
    const methods = new Set<string>();
    body.refunds?.forEach((refund, i) => {
      if (methods.has(refund.method)) {
        ctx.addIssue({
          code: 'custom',
          path: ['refunds', i, 'method'],
          message: 'Enter each refund method once',
        });
      }
      methods.add(refund.method);
    });
  });
export type CreateReturnBody = z.infer<typeof createReturnBodySchema>;

export const rejectReturnBodySchema = z.strictObject({
  reason: reasonSchema('rejecting the return'),
});
export type RejectReturnBody = z.infer<typeof rejectReturnBodySchema>;

export const listReturnsQuerySchema = paginationQuerySchema
  .extend({
    /** Return number, or part of it (case-insensitive). */
    q: searchTermSchema.optional(),
    status: z.enum(RETURN_STATUSES).optional(),
    saleId: z.uuid().optional(),
    /** Ignored for cashiers, who only ever see the returns they requested. */
    requestedById: z.uuid().optional(),
    /** Request dates, inclusive, as days in the pharmacy's timezone. */
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });
export type ListReturnsQuery = z.infer<typeof listReturnsQuerySchema>;

/** Find a sale to return against, by id or by the receipt number on the slip. */
export const returnableQuerySchema = z
  .strictObject({
    saleId: z.uuid().optional(),
    receiptNumber: z.string().trim().toUpperCase().min(1).max(30).optional(),
  })
  .refine((q) => (q.saleId === undefined) !== (q.receiptNumber === undefined), {
    message: 'Give either saleId or receiptNumber',
  });
export type ReturnableQuery = z.infer<typeof returnableQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────
// All money is a PKR decimal string with 2 decimal places, e.g. "120.50".

export type ReturnItemDto = {
  id: string;
  saleItemId: string;
  medicine: SaleItemDto['medicine'];
  batch: SaleItemDto['batch'];
  quantity: number;
  /** Requested value while PENDING; what actually happened once COMPLETED. */
  restock: boolean;
  refundAmount: string;
};

export type ReturnRefundDto = {
  id: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
};

export type ReturnSaleRef = { id: string; receiptNumber: string; soldAt: string };

export type ReturnSummaryDto = {
  id: string;
  returnNumber: string;
  status: ReturnStatus;
  sale: ReturnSaleRef;
  requestedBy: SaleUserRef;
  requestedAt: string;
  reviewedBy: SaleUserRef | null;
  reviewedAt: string | null;
  refundTotal: string;
  /** Total units across all lines. */
  itemCount: number;
};

export type ReturnDto = ReturnSummaryDto & {
  reason: string;
  rejectionReason: string | null;
  items: ReturnItemDto[];
  refunds: ReturnRefundDto[];
};

/** A sale line with how much of it can still come back. */
export type ReturnableLineDto = SaleItemDto & {
  /** Units on completed returns. */
  returnedQuantity: number;
  /** Units on returns waiting for approval; they can't be returned again. */
  pendingQuantity: number;
  returnableQuantity: number;
};

/** What a method can still refund: paid that way minus completed and pending refunds. */
export type RefundableDto = { method: PaymentMethod; paid: string; available: string };

export type ReturnableSaleDto = {
  sale: ReturnSaleRef & { status: SaleStatus; cashier: SaleUserRef; grandTotal: string };
  lines: ReturnableLineDto[];
  refundable: RefundableDto[];
  /** False when the sale is voided or nothing is left to return. */
  canReturn: boolean;
};
