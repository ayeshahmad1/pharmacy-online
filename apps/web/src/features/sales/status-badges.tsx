import type { ReturnStatus, SaleStatus } from '@pharmacy/shared';
import { Badge } from '@/components/ui/badge';

export const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  COMPLETED: 'Completed',
  VOIDED: 'Voided',
  REFUNDED: 'Refunded',
};

const saleVariant = { COMPLETED: 'success', VOIDED: 'danger', REFUNDED: 'warning' } as const;

export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  return <Badge variant={saleVariant[status]}>{SALE_STATUS_LABELS[status]}</Badge>;
}

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  PENDING: 'Awaiting approval',
  COMPLETED: 'Completed',
  REJECTED: 'Rejected',
  VOIDED: 'Voided',
};

const returnVariant = {
  PENDING: 'warning',
  COMPLETED: 'success',
  REJECTED: 'secondary',
  VOIDED: 'secondary',
} as const;

export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  return <Badge variant={returnVariant[status]}>{RETURN_STATUS_LABELS[status]}</Badge>;
}
