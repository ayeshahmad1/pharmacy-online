import type { SellableMedicineDto } from '@pharmacy/shared';
import { formatDate, formatQuantity } from '@/lib/format';
import { daysUntil, expiryStatus, stockStatus, type Status } from '@/lib/stock-status';

type Stock = Pick<
  SellableMedicineDto,
  'sellableQuantity' | 'expiredQuantity' | 'isLowStock' | 'unit' | 'nextExpiry'
>;

export const isSellable = (m: Pick<Stock, 'sellableQuantity'>) => m.sellableQuantity > 0;

/**
 * What the counter can sell, in the warning levels every stock screen uses.
 * Stock left only in expired batches is named as such: it is never sold
 * (rule 2), and the customer needs a substitute.
 */
export function availabilityStatus(m: Stock): Status {
  if (!isSellable(m) && m.expiredQuantity > 0) {
    return { tone: 'danger', label: 'Only expired stock' };
  }
  const status = stockStatus(m);
  if (status.tone === 'danger') return status;
  const quantity = formatQuantity(m.sellableQuantity, m.unit);
  return { tone: status.tone, label: status.tone === 'warning' ? `Low: ${quantity}` : quantity };
}

/** The expiry of the batch FEFO will sell from next, with its warning level. */
export function nextExpiryStatus(m: Stock, today = new Date()): Status | null {
  if (!m.nextExpiry) return null;
  const tone = expiryStatus({
    isExpired: false,
    daysToExpiry: daysUntil(m.nextExpiry, today),
  }).tone;
  return { tone, label: `Exp ${formatDate(m.nextExpiry)}` };
}
