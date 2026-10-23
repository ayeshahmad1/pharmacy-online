// Pure return arithmetic: how much a returned quantity refunds, and how the
// refund is split over payment methods. No database access, so every rule
// here is unit-tested directly (returns.calc.test.ts). All money is in paisa.

import { PAYMENT_METHODS, type PaymentMethod } from '@pharmacy/shared';
import { badRequest } from '../../lib/errors';
import { type Paisa, formatPaisa, sumPaisa } from '../../lib/money';

// ─── Line refunds ───────────────────────────────────────────────────────────

/** A sale line and what is already spoken for by PENDING or COMPLETED returns. */
export type ReturnLineState = {
  /** Units sold on the line. */
  quantity: number;
  /** What the customer paid for the line, after its discount share. */
  lineTotal: Paisa;
  reservedQuantity: number;
  reservedRefund: Paisa;
};

/**
 * Refund for returning `quantity` more units of a line: the line's paid
 * total pro rata, rounded down to the paisa, except that the return taking
 * the last units gets whatever is left. So once a line has come back in
 * full, its refunds add up to exactly what was paid for it, however it was
 * split. Rounding down keeps every earlier refund at or below its share, so
 * the remainder is never negative. A rejected return frees its quantity and
 * amount together, which keeps this true.
 */
export function lineRefund(line: ReturnLineState, quantity: number): Paisa {
  const remaining = line.quantity - line.reservedQuantity;
  if (quantity < 1 || quantity > remaining) {
    throw new Error(`Cannot return ${quantity} of ${remaining} remaining units`);
  }
  if (quantity === remaining) return line.lineTotal - line.reservedRefund;
  return (line.lineTotal * BigInt(quantity)) / BigInt(line.quantity);
}

// ─── Refund methods ─────────────────────────────────────────────────────────

/** What a method can still refund on the sale: paid that way minus reserved refunds. */
export type RefundCapacity = Map<PaymentMethod, Paisa>;

export type RefundRequest = { method: PaymentMethod; amount: Paisa; reference: string | null };
export type RefundRow = RefundRequest;

const label: Record<PaymentMethod, string> = {
  CASH: 'cash',
  CARD: 'card',
  MOBILE_WALLET: 'mobile wallet',
};

/**
 * Splits `total` over payment methods. Refunds only go back by a method the
 * sale was paid with, and never more than was paid that way minus earlier
 * refunds. With no split given: cash first, then card, then wallet.
 */
export function planRefunds(
  total: Paisa,
  capacity: RefundCapacity,
  requested: RefundRequest[] | undefined,
): RefundRow[] {
  const available = (method: PaymentMethod) => capacity.get(method) ?? 0n;

  if (!requested) {
    const rows: RefundRow[] = [];
    let left = total;
    for (const method of PAYMENT_METHODS) {
      const take = left < available(method) ? left : available(method);
      if (take > 0n) rows.push({ method, amount: take, reference: null });
      left -= take;
    }
    if (left > 0n) {
      // Can't happen while refunds never exceed line totals; guard anyway.
      throw new Error(`Refund ${formatPaisa(total)} exceeds what the sale can refund`);
    }
    return rows;
  }

  const issues = requested.flatMap((r, index) => {
    const max = available(r.method);
    if (max === 0n) {
      return [{ index, field: 'method', message: `Nothing can be refunded by ${label[r.method]}` }];
    }
    if (r.amount > max) {
      return [
        {
          index,
          field: 'amount',
          message: `At most ${formatPaisa(max)} can be refunded by ${label[r.method]}`,
          available: formatPaisa(max),
        },
      ];
    }
    return [];
  });
  if (issues.length > 0) throw badRequest('Some refunds are not allowed', { refunds: issues });

  const requestedTotal = sumPaisa(requested.map((r) => r.amount));
  if (requestedTotal !== total) {
    throw badRequest(
      `Refunds add up to ${formatPaisa(requestedTotal)} but the refund due is ${formatPaisa(total)}`,
      { field: 'refunds', due: formatPaisa(total), requested: formatPaisa(requestedTotal) },
    );
  }
  return requested;
}
