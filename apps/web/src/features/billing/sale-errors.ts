// Turns a rejected sale into something the counter can act on: which cart
// line is short of stock (and whether what is left is expired), which
// discount is too big, or whether the payment is wrong. The API answers with
// details keyed by the item's index in the request, which is the cart's order.

import { ApiError } from '@/lib/api';
import { formatQuantity } from '@/lib/format';
import { serverFieldErrors } from '@/lib/form';
import type { Cart } from './cart';

export type StockUpdate = { medicineId: string; available: number; expired: number };

export type SaleProblem = {
  message: string;
  /** Problems per cart line, by medicine id. */
  lines: Record<string, string>;
  /** Medicines with nothing sellable left: offer a substitute. */
  unavailable: string[];
  /** What the API says is in stock now, to refresh the cart's snapshots. */
  stockUpdates: StockUpdate[];
  billDiscount: string | null;
  payment: string | null;
  /**
   * The request may not have reached the server, or the server failed.
   * Retrying is safe: the idempotency key stops a double sale.
   */
  retryable: boolean;
  /** An earlier attempt of this bill was saved; charging again would double it. */
  alreadySaved: boolean;
};

type ShortItem = {
  index: number;
  medicineId: string;
  requested: number;
  available: number;
  name: string;
  unit: string;
  expiredQuantity: number;
};

type LineIssue = { index: number; field?: string; message: string };

const empty = (message: string): SaleProblem => ({
  message,
  lines: {},
  unavailable: [],
  stockUpdates: [],
  billDiscount: null,
  payment: null,
  retryable: false,
  alreadySaved: false,
});

/** The cart-line message for a stock shortage. Expired stock is called out: it is never sold. */
export function shortageMessage(item: {
  available: number;
  expiredQuantity: number;
  unit: string;
}): string {
  const { available, expiredQuantity: expired, unit } = item;
  if (available <= 0) {
    return expired > 0
      ? `Only expired stock left (${formatQuantity(expired, unit)}), which can't be sold`
      : 'Out of stock';
  }
  const extra = expired > 0 ? ` (${formatQuantity(expired, unit)} expired)` : '';
  return `Only ${formatQuantity(available, unit)} in stock${extra}. Lower the quantity.`;
}

export function saleProblem(err: unknown, cart: Cart): SaleProblem {
  if (!(err instanceof ApiError)) {
    return { ...empty(err instanceof Error ? err.message : 'Something went wrong') };
  }
  const medicineAt = (index: number) => cart.lines[index]?.medicine.id;
  const details = (typeof err.details === 'object' && err.details) || {};

  if (err.code === 'NETWORK_ERROR' || err.status >= 500) {
    return {
      ...empty(
        err.code === 'NETWORK_ERROR'
          ? 'Cannot reach the server. The bill is kept; try again. Retrying is safe: it will not be charged twice.'
          : `${err.message}. The bill is kept; try again.`,
      ),
      retryable: true,
    };
  }

  if (err.code === 'IDEMPOTENCY_KEY_REUSED') {
    return {
      ...empty(
        'This bill was already saved by an earlier attempt whose reply was lost, and the cart has changed since. Check Sales before charging the customer again.',
      ),
      alreadySaved: true,
    };
  }

  if (err.code === 'INSUFFICIENT_STOCK') {
    const items = ((details as { items?: ShortItem[] }).items ?? []).filter(
      (i) => typeof i.index === 'number',
    );
    const problem = empty(err.message);
    for (const item of items) {
      const id = medicineAt(item.index) ?? item.medicineId;
      problem.lines[id] = shortageMessage(item);
      problem.stockUpdates.push({
        medicineId: id,
        available: item.available,
        expired: item.expiredQuantity,
      });
      if (item.available <= 0) problem.unavailable.push(id);
    }
    return problem;
  }

  // Cashier discount cap (403 with the cap in details).
  if (err.code === 'FORBIDDEN' && 'maxDiscount' in details) {
    return { ...empty(err.message), billDiscount: err.message };
  }

  const problem = empty(err.message);
  const d = details as { field?: unknown; items?: unknown };
  if (Array.isArray(d.items)) {
    for (const issue of d.items as LineIssue[]) {
      const id = medicineAt(issue.index);
      if (id) problem.lines[id] = issue.message;
    }
  }
  if (d.field === 'discount') problem.billDiscount = err.message;
  if (d.field === 'payments') problem.payment = err.message;

  // Request validation: keys like "items.0.quantity", "discount", "payments".
  if (err.code === 'VALIDATION_ERROR') {
    for (const [key, message] of Object.entries(serverFieldErrors(err))) {
      const [head, index] = key.split('.');
      if (head === 'items' && index !== undefined) {
        const id = medicineAt(Number(index));
        if (id) problem.lines[id] = message;
      } else if (head === 'discount') problem.billDiscount = message;
      else if (head === 'payments') problem.payment = message;
    }
  }
  return problem;
}
