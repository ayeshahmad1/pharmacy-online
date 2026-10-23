// The billing cart as plain data plus pure functions, so every rule here is
// unit-tested (cart.test.ts). Totals mirror the API's pricing exactly (line
// discounts, then the bill discount spread over the lines by value), so the
// screen shows what the receipt will say. The API is still the authority: it
// re-prices every sale from the catalogue (CLAUDE.md rule 11).

import {
  discountSchema,
  type CreateSaleBody,
  type DiscountInput,
  type DiscountType,
  type SellableMedicineDto,
} from '@pharmacy/shared';
import { allocate, paisaToAmount, percentOf, sumPaisa, toPaisa } from '@/lib/money';

/** The most units of one medicine on one bill; matches the API's limit. */
export const MAX_LINE_QUANTITY = 10_000;
/** The most lines on one bill; matches the API's limit. */
export const MAX_CART_LINES = 100;

/** A discount as typed: the value stays text until it is sent (rule 6). */
export type DiscountDraft = { type: DiscountType; value: string };

export type CartLine = {
  /** Snapshot from the search that added it: name, price and stock at that moment. */
  medicine: SellableMedicineDto;
  quantity: number;
  discount: DiscountDraft | null;
};

export type Cart = {
  lines: CartLine[];
  discount: DiscountDraft | null;
  /**
   * Sent with the sale and kept for every retry of this bill, so a sale whose
   * response was lost is never saved twice. A new bill gets a new key.
   */
  idempotencyKey: string;
  notes: string;
};

export function newCart(): Cart {
  return { lines: [], discount: null, idempotencyKey: crypto.randomUUID(), notes: '' };
}

export const cartUnits = (cart: Cart) => cart.lines.reduce((sum, l) => sum + l.quantity, 0);

export const clampQuantity = (q: number) =>
  Math.min(MAX_LINE_QUANTITY, Math.max(1, Math.trunc(Number.isFinite(q) ? q : 1)));

/**
 * Adds `quantity` of a medicine. A medicine already in the cart gets the units
 * added to its line (the API takes one line per medicine) and a fresh stock
 * snapshot.
 */
export function addToCart(cart: Cart, medicine: SellableMedicineDto, quantity = 1): Cart {
  const existing = cart.lines.find((l) => l.medicine.id === medicine.id);
  if (existing) {
    return {
      ...cart,
      lines: cart.lines.map((l) =>
        l === existing ? { ...l, medicine, quantity: clampQuantity(l.quantity + quantity) } : l,
      ),
    };
  }
  return {
    ...cart,
    lines: [...cart.lines, { medicine, quantity: clampQuantity(quantity), discount: null }],
  };
}

export function setQuantity(cart: Cart, medicineId: string, quantity: number): Cart {
  return updateLine(cart, medicineId, { quantity: clampQuantity(quantity) });
}

export function setLineDiscount(
  cart: Cart,
  medicineId: string,
  discount: DiscountDraft | null,
): Cart {
  return updateLine(cart, medicineId, { discount });
}

export function removeLine(cart: Cart, medicineId: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.medicine.id !== medicineId) };
}

function updateLine(cart: Cart, medicineId: string, change: Partial<CartLine>): Cart {
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.medicine.id === medicineId ? { ...l, ...change } : l)),
  };
}

// ─── Pricing ────────────────────────────────────────────────────────────────

export type PricedLine = {
  medicineId: string;
  /** quantity × unit price */
  gross: bigint;
  /** The line's own discount. */
  lineDiscount: bigint;
  /** This line's share of the bill discount. */
  billShare: bigint;
  /** gross − both discounts: what the customer pays for the line. */
  total: bigint;
  /** A discount that can't be applied as entered. */
  error: string | null;
};

export type CartTotals = {
  lines: PricedLine[];
  subtotal: bigint;
  lineDiscounts: bigint;
  /** What the bill discount applies to: the subtotal after line discounts. */
  netBeforeBillDiscount: bigint;
  billDiscount: bigint;
  discountTotal: bigint;
  grandTotal: bigint;
  billDiscountError: string | null;
  /** True when every discount is valid, so the bill can go to payment. */
  valid: boolean;
};

type ParsedDiscount = { discount: DiscountInput | undefined; error: string | null };

/** Checks a typed discount against the shared schema. Null or blank means none. */
export function parseDiscount(draft: DiscountDraft | null): ParsedDiscount {
  if (!draft || draft.value.trim() === '') return { discount: undefined, error: null };
  const parsed = discountSchema.safeParse({ type: draft.type, value: draft.value });
  if (parsed.success) return { discount: parsed.data, error: null };
  return { discount: undefined, error: parsed.error.issues[0]?.message ?? 'Invalid discount' };
}

function discountAmount(base: bigint, discount: DiscountInput | undefined): bigint {
  if (!discount) return 0n;
  return discount.type === 'PERCENT'
    ? percentOf(base, discount.value)
    : (toPaisa(discount.value) ?? 0n);
}

/**
 * The discount `draft` gives on `base` (a line's quantity × price, or the
 * bill after line discounts). Zero with an error when it can't be applied.
 */
export function applyDiscount(
  base: bigint,
  draft: DiscountDraft | null,
  on: 'line' | 'bill',
): { amount: bigint; error: string | null } {
  const parsed = parseDiscount(draft);
  if (parsed.error) return { amount: 0n, error: parsed.error };
  const amount = discountAmount(base, parsed.discount);
  if (amount > base) {
    return {
      amount: 0n,
      error: `Discount is more than the ${on} total (Rs ${paisaToAmount(base)})`,
    };
  }
  return { amount, error: null };
}

/** quantity × catalogue unit price, in paisa. */
export const lineGross = (line: CartLine) =>
  (toPaisa(line.medicine.sellingPrice) ?? 0n) * BigInt(line.quantity);

/** Prices the cart the way the API's priceSale does. */
export function priceCart(cart: Cart): CartTotals {
  const lines: PricedLine[] = cart.lines.map((line) => {
    const gross = lineGross(line);
    const { amount: lineDiscount, error } = applyDiscount(gross, line.discount, 'line');
    return {
      medicineId: line.medicine.id,
      gross,
      lineDiscount,
      billShare: 0n,
      total: gross - lineDiscount,
      error,
    };
  });

  const nets = lines.map((l) => l.total);
  const netTotal = sumPaisa(nets);
  const { amount: billDiscount, error: billDiscountError } = applyDiscount(
    netTotal,
    cart.discount,
    'bill',
  );
  allocate(billDiscount, nets).forEach((share, i) => {
    lines[i]!.billShare = share;
    lines[i]!.total -= share;
  });

  const subtotal = sumPaisa(lines.map((l) => l.gross));
  const lineDiscounts = sumPaisa(lines.map((l) => l.lineDiscount));
  const discountTotal = lineDiscounts + billDiscount;
  return {
    lines,
    subtotal,
    lineDiscounts,
    netBeforeBillDiscount: netTotal,
    billDiscount,
    discountTotal,
    grandTotal: subtotal - discountTotal,
    billDiscountError,
    valid: !billDiscountError && lines.every((l) => !l.error),
  };
}

/**
 * Units on the bill beyond what the last lookup said is sellable. A warning
 * only: stock may have arrived since, and the API decides at payment.
 */
export function stockShortfall(line: CartLine): number {
  return Math.max(0, line.quantity - line.medicine.sellableQuantity);
}

// ─── Request ────────────────────────────────────────────────────────────────

/** The sale request for this cart. Items keep the cart's order, so API errors map back by index. */
export function toSaleBody(cart: Cart, payments: CreateSaleBody['payments']): CreateSaleBody {
  const billDiscount = parseDiscount(cart.discount).discount;
  return {
    idempotencyKey: cart.idempotencyKey,
    items: cart.lines.map((line) => {
      const { discount } = parseDiscount(line.discount);
      return {
        medicineId: line.medicine.id,
        quantity: line.quantity,
        ...(discount && { discount }),
      };
    }),
    ...(billDiscount && { discount: billDiscount }),
    payments,
    notes: cart.notes.trim() || undefined,
  };
}

// ─── Search input ───────────────────────────────────────────────────────────

/**
 * What the search box holds: an optional quantity prefix and the term, e.g.
 * "3*8964000123457" (scan three) or "12 * panadol". Without a prefix the
 * quantity is 1.
 */
export function parseScan(text: string): { quantity: number; term: string } {
  const match = /^\s*(\d{1,5})\s*\*\s*(.*)$/.exec(text);
  if (!match) return { quantity: 1, term: text.trim() };
  return { quantity: clampQuantity(Number(match[1])), term: match[2]!.trim() };
}
