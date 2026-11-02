import type { DeliveryStatus } from '@pharmacy/shared';
import { Badge } from '@/components/ui/badge';

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  PENDING: 'Awaiting approval',
  APPROVED: 'Received',
  REJECTED: 'Rejected',
};

const variant = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'secondary' } as const;

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  return <Badge variant={variant[status]}>{DELIVERY_STATUS_LABELS[status]}</Badge>;
}
