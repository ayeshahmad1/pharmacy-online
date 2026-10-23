/**
 * Warning levels for stock and expiry, shared by every list so the same batch
 * looks equally urgent everywhere. Expired stock can never be sold (rule 2);
 * the colours tell staff what to act on first.
 */

export type Tone = 'danger' | 'warning' | 'ok';

/** Expiring within this many days is critical: likely to expire on the shelf. */
export const CRITICAL_EXPIRY_DAYS = 30;
/** Expiring within this many days deserves a warning. Matches the API's default window. */
export const WARNING_EXPIRY_DAYS = 90;

export type Status = { tone: Tone; label: string };

export function expiryStatus(batch: { isExpired: boolean; daysToExpiry: number }): Status {
  const days = batch.daysToExpiry;
  if (batch.isExpired || days <= 0) return { tone: 'danger', label: 'Expired' };
  const label = days === 1 ? 'Expires tomorrow' : `${days} days left`;
  if (days <= CRITICAL_EXPIRY_DAYS) return { tone: 'danger', label };
  if (days <= WARNING_EXPIRY_DAYS) return { tone: 'warning', label };
  return { tone: 'ok', label };
}

export function stockStatus(stock: { sellableQuantity: number; isLowStock: boolean }): Status {
  if (stock.sellableQuantity <= 0) return { tone: 'danger', label: 'Out of stock' };
  if (stock.isLowStock) return { tone: 'warning', label: 'Low stock' };
  return { tone: 'ok', label: 'In stock' };
}

/** Days between today and a "YYYY-MM-DD" date in the browser's calendar; negative is past. */
export function daysUntil(date: string, today = new Date()): number {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y!, m! - 1, d);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - start) / 86_400_000);
}
