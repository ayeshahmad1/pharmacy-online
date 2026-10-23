// Mirrors of the Prisma enums in apps/api/prisma/schema.prisma, so the web app
// can use them without depending on Prisma. Keep the two in sync.

export const CURRENCY = 'PKR';

export const ROLE_CODES = ['ADMIN', 'PHARMACIST', 'CASHIER'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const RECORD_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const STOCK_MOVEMENT_TYPES = [
  'PURCHASE',
  'SALE',
  'RETURN',
  'ADJUSTMENT',
  'EXPIRED_WRITEOFF',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const SALE_STATUSES = ['COMPLETED', 'VOIDED', 'REFUNDED'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const RETURN_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED', 'VOIDED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const PAYMENT_METHODS = ['CASH', 'CARD', 'MOBILE_WALLET'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
