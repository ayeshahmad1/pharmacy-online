// The return form's arithmetic, mirroring the API (CLAUDE.md rule 12) so the
// refund shown is the refund the server will compute: a line refunds its paid
// total pro rata, rounded down to the paisa, and the return taking a line's
// last units gets exactly what is left of it. Refunds go back by the methods
// the sale was paid with: cash first, then card, then wallet, unless staff
// choose a split. All money is exact paisa (BigInt); amounts stay text in the
// form. The server re-checks everything.

import {
  PAYMENT_METHODS,
  type PaymentMethod,
  type RefundableDto,
  type ReturnableLineDto,
} from '@pharmacy/shared';
import { PAYMENT_LABELS } from '@/features/billing/payments';
import { ApiError } from '@/lib/api';
import type { FieldErrors } from '@/lib/form';
import { formatMoney, paisaToAmount, sumPaisa, toPaisa } from '@/lib/money';
import { daysUntil } from '@/lib/stock-status';

// ─── Lines ──────────────────────────────────────────────────────────────────

/** What staff entered for one sale line. Quantity stays text; blank means none. */
export type LineDraft = { quantity: string; restock: boolean };
export type LineDrafts = Record<string, LineDraft>;

/** The batch has expired (as the server counts it: on its expiry day). Never restocked. */
export function batchExpired(line: ReturnableLineDto, today = new Date()): boolean {
  return daysUntil(line.batch.expiryDate, today) <= 0;
}

export function emptyDrafts(lines: ReturnableLineDto[], today = new Date()): LineDrafts {
  return Object.fromEntries(
    lines.map((l) => [l.id, { quantity: '', restock: !batchExpired(l, today) }]),
  );
}

/** "" → 0, a whole number → itself, anything else → null. */
export function draftQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Refund for returning `quantity` more units of a line, exactly as the API's
 * lineRefund: the last units get what is left; fewer get lineTotal × q ÷ sold.
 */
export function lineRefund(line: ReturnableLineDto, quantity: number): bigint {
  if (quantity <= 0) return 0n;
  if (quantity >= line.returnableQuantity) return toPaisa(line.refundableAmount) ?? 0n;
  return ((toPaisa(line.lineTotal) ?? 0n) * BigInt(quantity)) / BigInt(line.quantity);
}

export type ReturnPlan = {
  items: { saleItemId: string; quantity: number; restock: boolean }[];
  /** Refund per sale line id, for lines being returned. */
  refunds: Record<string, bigint>;
  total: bigint;
  units: number;
  /** Per line, keyed `line.<saleItemId>`. */
  errors: FieldErrors;
};

export function planReturn(
  lines: ReturnableLineDto[],
  drafts: LineDrafts,
  today = new Date(),
): ReturnPlan {
  const plan: ReturnPlan = { items: [], refunds: {}, total: 0n, units: 0, errors: {} };
  for (const line of lines) {
    const draft = drafts[line.id];
    if (!draft) continue;
    const quantity = draftQuantity(draft.quantity);
    const key = `line.${line.id}`;
    if (quantity === null) {
      plan.errors[key] = 'Enter a whole number';
    } else if (quantity > line.returnableQuantity) {
      plan.errors[key] =
        line.returnableQuantity === 0
          ? 'Nothing left to return on this line'
          : `At most ${line.returnableQuantity} can come back`;
    } else if (quantity > 0) {
      const refund = lineRefund(line, quantity);
      plan.items.push({
        saleItemId: line.id,
        quantity,
        restock: draft.restock && !batchExpired(line, today),
      });
      plan.refunds[line.id] = refund;
      plan.total += refund;
      plan.units += quantity;
    }
  }
  return plan;
}

// ─── Refund split ───────────────────────────────────────────────────────────

/** One refund method as staff edit it. Amount stays text; blank means none. */
export type RefundDraft = { method: PaymentMethod; amount: string; reference: string };

const capacityOf = (refundable: RefundableDto[], method: PaymentMethod) =>
  toPaisa(refundable.find((r) => r.method === method)?.available ?? '0') ?? 0n;

/** What the API does when no split is sent: cash first, then card, then wallet. */
export function defaultSplit(
  total: bigint,
  refundable: RefundableDto[],
): { method: PaymentMethod; amount: bigint }[] {
  const rows: { method: PaymentMethod; amount: bigint }[] = [];
  let left = total;
  for (const method of PAYMENT_METHODS) {
    const available = capacityOf(refundable, method);
    const take = left < available ? left : available;
    if (take > 0n) rows.push({ method, amount: take });
    left -= take;
  }
  return rows;
}

/**
 * Editable rows for the methods that can still refund something, prefilled
 * with the default split.
 */
export function splitDrafts(total: bigint, refundable: RefundableDto[]): RefundDraft[] {
  const split = defaultSplit(total, refundable);
  return PAYMENT_METHODS.filter((m) => capacityOf(refundable, m) > 0n).map((method) => {
    const amount = split.find((s) => s.method === method)?.amount ?? 0n;
    return { method, amount: amount > 0n ? paisaToAmount(amount) : '', reference: '' };
  });
}

export type SplitCheck = {
  ok: boolean;
  entered: bigint;
  /** Keyed by method. */
  fieldErrors: Partial<Record<PaymentMethod, string>>;
  error: string | null;
  /** The rows to send, money as strings. */
  refunds: { method: PaymentMethod; amount: string; reference?: string }[];
};

export function checkSplit(
  total: bigint,
  refundable: RefundableDto[],
  drafts: RefundDraft[],
): SplitCheck {
  const fieldErrors: SplitCheck['fieldErrors'] = {};
  const refunds: SplitCheck['refunds'] = [];
  const amounts: bigint[] = [];
  for (const d of drafts) {
    if (d.amount.trim() === '') continue;
    const paisa = toPaisa(d.amount);
    const available = capacityOf(refundable, d.method);
    // Count what was typed even when it is over the limit, so the total shown adds up.
    if (paisa !== null) amounts.push(paisa);
    if (paisa === null) {
      fieldErrors[d.method] = 'Enter an amount like "120" or "120.50"';
    } else if (paisa > available) {
      fieldErrors[d.method] =
        `At most ${formatMoney(available)} can go back by ${PAYMENT_LABELS[d.method].toLowerCase()}`;
    } else if (paisa > 0n) {
      const reference = d.reference.trim();
      refunds.push({
        method: d.method,
        amount: paisaToAmount(paisa),
        ...(reference && { reference }),
      });
    }
  }
  const entered = sumPaisa(amounts);
  const error =
    Object.keys(fieldErrors).length === 0 && entered !== total
      ? `The split adds up to ${formatMoney(entered)}; the refund due is ${formatMoney(total)}`
      : null;
  return {
    ok: Object.keys(fieldErrors).length === 0 && error === null,
    entered,
    fieldErrors,
    error,
    refunds,
  };
}

// ─── Server errors ──────────────────────────────────────────────────────────

/**
 * The API's refusals mapped onto the form: lines (`line.<saleItemId>`),
 * refund methods (`refund.<METHOD>`), the split as a whole (`refunds`) and
 * plain fields such as `reason`. `sent` is what was submitted, since the API
 * points at lines and refunds by their index in the request.
 */
export function returnErrorFields(
  err: unknown,
  sent: { items: { saleItemId: string }[]; refunds?: { method: PaymentMethod }[] },
): FieldErrors {
  if (!(err instanceof ApiError) || typeof err.details !== 'object' || err.details === null) {
    return {};
  }
  const details = err.details as {
    field?: unknown;
    items?: unknown;
    refunds?: unknown;
    body?: { fieldErrors?: Record<string, string[] | undefined> };
  };
  const errors: FieldErrors = {};

  for (const [key, messages] of Object.entries(details.body?.fieldErrors ?? {})) {
    if (messages?.[0]) errors[key] = messages[0];
  }
  if (details.field === 'refunds') errors.refunds = err.message;

  if (Array.isArray(details.items)) {
    for (const issue of details.items as {
      index?: number;
      message?: string;
      returnable?: number;
    }[]) {
      const line = typeof issue.index === 'number' ? sent.items[issue.index] : undefined;
      if (!line) continue;
      errors[`line.${line.saleItemId}`] =
        issue.message ??
        (issue.returnable === 0
          ? 'Nothing left to return on this line'
          : `Only ${issue.returnable ?? 0} can still be returned`);
    }
  }
  if (Array.isArray(details.refunds)) {
    for (const issue of details.refunds as { index?: number; message?: string }[]) {
      const refund = typeof issue.index === 'number' ? sent.refunds?.[issue.index] : undefined;
      if (refund && issue.message) errors[`refund.${refund.method}`] = issue.message;
    }
  }
  return errors;
}
