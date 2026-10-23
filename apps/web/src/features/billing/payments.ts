// Payment entry for the pay dialog, mirroring the API's settlePayments so the
// dialog only lets through what the server will accept (CLAUDE.md rule 11):
// card and wallet are charged exactly and together may not exceed the bill,
// change only ever comes out of cash, and cash must be needed if given.

import { PAYMENT_METHODS, type PaymentInput, type PaymentMethod } from '@pharmacy/shared';
import { formatMoney, paisaToAmount, toPaisa } from '@/lib/money';

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  MOBILE_WALLET: 'Mobile wallet',
};

/** One row of the pay dialog. Amount stays text (rule 6); blank means "not used". */
export type TenderDraft = { method: PaymentMethod; amount: string; reference: string };

export const emptyTenders = (): TenderDraft[] =>
  PAYMENT_METHODS.map((method) => ({ method, amount: '', reference: '' }));

export type Settlement = {
  cash: bigint;
  /** Card plus wallet. */
  nonCash: bigint;
  paid: bigint;
  /** Still owed; zero once the tenders cover the bill. */
  remaining: bigint;
  change: bigint;
  /** Per-row problems, e.g. an amount that is not money. */
  fieldErrors: Partial<Record<PaymentMethod, string>>;
  /** Why the tenders can't be accepted as a whole, if they can't. */
  error: string | null;
  ok: boolean;
};

export function settle(grandTotal: bigint, tenders: TenderDraft[]): Settlement {
  const fieldErrors: Settlement['fieldErrors'] = {};
  let cash = 0n;
  let nonCash = 0n;
  for (const t of tenders) {
    if (t.amount.trim() === '') continue;
    const amount = toPaisa(t.amount);
    if (amount === null) {
      fieldErrors[t.method] = 'Enter an amount like 500 or 120.50';
      continue;
    }
    if (t.method === 'CASH') cash += amount;
    else nonCash += amount;
  }
  const paid = cash + nonCash;
  const remaining = paid >= grandTotal ? 0n : grandTotal - paid;
  const change = paid > grandTotal ? paid - grandTotal : 0n;

  let error: string | null = null;
  if (Object.keys(fieldErrors).length > 0) {
    error = 'Fix the marked amounts';
  } else if (nonCash > grandTotal) {
    error = `Card and wallet together (${formatMoney(nonCash)}) can't be more than the bill (${formatMoney(grandTotal)}). Change is only given from cash.`;
  } else if (remaining > 0n) {
    error = `${formatMoney(remaining)} still to pay`;
  } else if (cash > 0n && cash === change) {
    error = 'Cash is not needed: card and wallet already cover the bill';
  }
  return { cash, nonCash, paid, remaining, change, fieldErrors, error, ok: error === null };
}

/** The tenders as the API takes them: blank rows dropped, references trimmed. */
export function toPayments(tenders: TenderDraft[]): PaymentInput[] {
  return tenders.flatMap((t) => {
    const amount = toPaisa(t.amount);
    if (amount === null || amount === 0n) return [];
    const reference = t.method === 'CASH' ? '' : t.reference.trim();
    return [{ method: t.method, amount: paisaToAmount(amount), ...(reference && { reference }) }];
  });
}

const NOTES = [100_00n, 500_00n, 1000_00n, 5000_00n];

/**
 * Quick cash amounts for `due`: the exact amount, then the next round amounts
 * a customer is likely to hand over (next 100, 500, 1,000, 5,000).
 */
export function cashSuggestions(due: bigint, max = 4): bigint[] {
  if (due <= 0n) return [];
  const out = [due];
  for (const note of NOTES) {
    const rounded = ((due + note - 1n) / note) * note;
    if (!out.includes(rounded)) out.push(rounded);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, max);
}
