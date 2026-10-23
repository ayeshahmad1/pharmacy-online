import type { StockMovementType } from '@pharmacy/shared';

export const MOVEMENT_LABELS: Record<StockMovementType, string> = {
  PURCHASE: 'Received',
  SALE: 'Sold',
  RETURN: 'Returned',
  ADJUSTMENT: 'Adjusted',
  EXPIRED_WRITEOFF: 'Expired write-off',
};
