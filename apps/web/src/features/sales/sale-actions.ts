// What can still be done to a sale, mirroring the API's rules (CLAUDE.md
// rules 11 and 12), so the screen says why an action is unavailable instead
// of letting the server refuse it. The server still decides.

import type { ReturnStatus, SaleStatus } from '@pharmacy/shared';

type SaleState = { status: SaleStatus };
type ReturnState = { status: ReturnStatus };

/**
 * Why the sale cannot be voided, or null if it can. `returns` are the returns
 * raised against it (all of them: only ADMIN/PHARMACIST void, and they see
 * every return).
 */
export function voidBlocker(sale: SaleState, returns: readonly ReturnState[]): string | null {
  if (sale.status === 'VOIDED') return 'This sale is already voided.';
  if (sale.status === 'REFUNDED') {
    return 'Everything on this sale has been returned and refunded, so it cannot be voided.';
  }
  if (returns.some((r) => r.status === 'PENDING')) {
    return 'A return against this sale is waiting for approval. Approve or reject it first; a sale with returns cannot be voided.';
  }
  if (returns.some((r) => r.status === 'COMPLETED')) {
    return 'Items from this sale have already been returned. Use a return for the rest instead of voiding.';
  }
  return null;
}

/** Why nothing can be returned against the sale, or null if something may be. */
export function returnBlocker(sale: SaleState): string | null {
  if (sale.status === 'VOIDED') return 'This sale was voided; nothing can be returned.';
  if (sale.status === 'REFUNDED') return 'Everything on this sale has already been returned.';
  return null;
}
