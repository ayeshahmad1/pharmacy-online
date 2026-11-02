// Pure sale arithmetic: pricing with discounts, FEFO batch allocation and
// payment settlement. No database access, so every rule here is unit-tested
// directly (sales.calc.test.ts). All money is in paisa (see lib/money.ts).

import {
  type DiscountInput,
  PAYMENT_METHODS,
  type PaymentMethod,
  type SaleStatus,
} from '@pharmacy/shared';
import { badRequest } from '../../lib/errors';
import { type Paisa, allocate, formatPaisa, percentOf, sumPaisa, toPaisa } from '../../lib/money';

// ─── Pricing ────────────────────────────────────────────────────────────────

export type PricingLineInput = {
  quantity: number;
  unitPrice: Paisa;
  discount?: DiscountInput;
};

export type PricedLine = {
  quantity: number;
  unitPrice: Paisa;
  /** quantity × unitPrice */
  gross: Paisa;
  /** The line's own discount plus its share of the bill discount. */
  discount: Paisa;
};

export type PricedSale = {
  lines: PricedLine[];
  subtotal: Paisa;
  discountTotal: Paisa;
  grandTotal: Paisa;
};

function discountAmount(base: Paisa, discount: DiscountInput | undefined): Paisa {
  if (!discount) return 0n;
  return discount.type === 'PERCENT' ? percentOf(base, discount.value) : toPaisa(discount.value);
}

/**
 * Prices the cart. Line discounts apply to quantity × price; the bill
 * discount applies to what is left after them and is spread over the lines
 * in proportion to their remaining value, so each line carries its true share
 * (returns refund what the customer actually paid for that line).
 */
export function priceSale(items: PricingLineInput[], billDiscount?: DiscountInput): PricedSale {
  const issues: { index: number; field: string; message: string }[] = [];
  const lines = items.map((item, index) => {
    const gross = item.unitPrice * BigInt(item.quantity);
    const discount = discountAmount(gross, item.discount);
    if (discount > gross) {
      issues.push({
        index,
        field: 'discount',
        message: `Discount ${formatPaisa(discount)} is more than the line total ${formatPaisa(gross)}`,
      });
    }
    return { quantity: item.quantity, unitPrice: item.unitPrice, gross, discount };
  });
  if (issues.length > 0) throw badRequest('Some discounts are too large', { items: issues });

  const nets = lines.map((l) => l.gross - l.discount);
  const netTotal = sumPaisa(nets);
  const bill = discountAmount(netTotal, billDiscount);
  if (bill > netTotal) {
    throw badRequest(
      `Bill discount ${formatPaisa(bill)} is more than the bill total ${formatPaisa(netTotal)}`,
      { field: 'discount' },
    );
  }
  allocate(bill, nets).forEach((share, i) => (lines[i]!.discount += share));

  const subtotal = sumPaisa(lines.map((l) => l.gross));
  const discountTotal = sumPaisa(lines.map((l) => l.discount));
  return { lines, subtotal, discountTotal, grandTotal: subtotal - discountTotal };
}

/** Largest discount a capped role may give: `maxPercent`% of the subtotal. */
export const discountCap = (subtotal: Paisa, maxPercent: number): Paisa =>
  percentOf(subtotal, String(maxPercent));

// ─── FEFO ───────────────────────────────────────────────────────────────────

export type SellableBatch = { id: string; quantity: number };
export type BatchAllocation = { batchId: string; quantity: number };

/**
 * Takes `requested` units from `batches`, which must already be sellable
 * (not expired) and sorted earliest expiry first (CLAUDE.md rule 1). Returns
 * null when they don't hold enough in total (rule 3).
 */
export function allocateFefo(
  batches: SellableBatch[],
  requested: number,
): BatchAllocation[] | null {
  const allocations: BatchAllocation[] = [];
  let remaining = requested;
  for (const batch of batches) {
    if (remaining === 0) break;
    if (batch.quantity <= 0) continue;
    const take = Math.min(batch.quantity, remaining);
    allocations.push({ batchId: batch.id, quantity: take });
    remaining -= take;
  }
  return remaining === 0 ? allocations : null;
}

export type SaleLine = BatchAllocation & {
  unitPrice: Paisa;
  discount: Paisa;
  /** quantity × unitPrice − discount */
  lineTotal: Paisa;
};

/**
 * Turns one priced cart line into one sale line per batch it was taken from,
 * splitting its discount by quantity. Since a share never exceeds
 * ceil(discount × q / Q) ≤ unitPrice × q, no batch line goes negative.
 */
export function splitLine(line: PricedLine, allocations: BatchAllocation[]): SaleLine[] {
  const shares = allocate(
    line.discount,
    allocations.map((a) => BigInt(a.quantity)),
  );
  return allocations.map((a, i) => {
    const discount = shares[i]!;
    return {
      ...a,
      unitPrice: line.unitPrice,
      discount,
      lineTotal: line.unitPrice * BigInt(a.quantity) - discount,
    };
  });
}

// ─── Payments ───────────────────────────────────────────────────────────────

export type TenderInput = { method: PaymentMethod; amount: Paisa; reference: string | null };

export type PaymentRow = {
  method: PaymentMethod;
  /** Applied to the sale; the rows add up to the grand total. */
  amount: Paisa;
  /** Cash handed over, when change was given from it. */
  tendered: Paisa | null;
  reference: string | null;
};

export type Settlement = { payments: PaymentRow[]; tendered: Paisa; change: Paisa };

/**
 * Checks the tenders cover the bill and works out the change. Card and wallet
 * amounts are charged exactly, so together they may not exceed the total;
 * change only ever comes out of cash.
 */
export function settlePayments(grandTotal: Paisa, tenders: TenderInput[]): Settlement {
  const cash = tenders.filter((t) => t.method === 'CASH');
  const nonCashTotal = sumPaisa(tenders.filter((t) => t.method !== 'CASH').map((t) => t.amount));
  const cashTotal = sumPaisa(cash.map((t) => t.amount));
  const tendered = nonCashTotal + cashTotal;

  if (nonCashTotal > grandTotal) {
    throw badRequest(
      `Card and wallet payments (${formatPaisa(nonCashTotal)}) exceed the bill total (${formatPaisa(grandTotal)})`,
      { field: 'payments', due: formatPaisa(grandTotal), nonCash: formatPaisa(nonCashTotal) },
    );
  }
  if (tendered < grandTotal) {
    const short = grandTotal - tendered;
    throw badRequest(`Payment is short by ${formatPaisa(short)}`, {
      field: 'payments',
      due: formatPaisa(grandTotal),
      paid: formatPaisa(tendered),
      short: formatPaisa(short),
    });
  }

  const change = tendered - grandTotal;
  // Change is no more than the cash given, because non-cash ≤ total.
  const cashApplied = cashTotal - change;
  if (cash.length > 0 && cashApplied === 0n) {
    throw badRequest('Cash is not needed: the other payments already cover the bill', {
      field: 'payments',
    });
  }

  const payments = tenders.map((t): PaymentRow =>
    t.method === 'CASH'
      ? {
          method: t.method,
          amount: cashApplied,
          tendered: change > 0n ? t.amount : null,
          reference: t.reference,
        }
      : { method: t.method, amount: t.amount, tendered: null, reference: t.reference },
  );
  return { payments, tendered, change };
}

// ─── Day totals ─────────────────────────────────────────────────────────────

export type DaySale = {
  status: SaleStatus;
  itemCount: number;
  discountTotal: Paisa;
  grandTotal: Paisa;
  payments: { method: PaymentMethod; amount: Paisa }[];
};

export type DayTotals = {
  saleCount: number;
  itemCount: number;
  discountTotal: Paisa;
  grandTotal: Paisa;
  byMethod: Record<PaymentMethod, Paisa>;
  voidedCount: number;
  voidedTotal: Paisa;
};

/**
 * Totals for the day-end slip. A voided sale never happened as far as the
 * takings go, so it is only counted on its own; every other sale counts in
 * full, whatever was returned against it later.
 */
export function summarizeDay(sales: DaySale[]): DayTotals {
  const counted = sales.filter((s) => s.status !== 'VOIDED');
  const voided = sales.filter((s) => s.status === 'VOIDED');
  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0n])) as Record<
    PaymentMethod,
    Paisa
  >;
  for (const p of counted.flatMap((s) => s.payments)) byMethod[p.method] += p.amount;
  return {
    saleCount: counted.length,
    itemCount: counted.reduce((sum, s) => sum + s.itemCount, 0),
    discountTotal: sumPaisa(counted.map((s) => s.discountTotal)),
    grandTotal: sumPaisa(counted.map((s) => s.grandTotal)),
    byMethod,
    voidedCount: voided.length,
    voidedTotal: sumPaisa(voided.map((s) => s.grandTotal)),
  };
}
