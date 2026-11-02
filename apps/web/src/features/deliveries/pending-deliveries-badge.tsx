import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { deliveriesApi, deliveriesKeys } from './deliveries-api';

/** How many cashier deliveries wait for approval, next to "Deliveries" in a staff member's menu. */
export function PendingDeliveriesBadge() {
  const pending = useQuery({
    queryKey: deliveriesKeys.pendingCount,
    queryFn: async ({ signal }) =>
      (await deliveriesApi.list({ status: 'PENDING', pageSize: 1 }, signal)).total,
    refetchInterval: 60_000,
    retry: false,
  });
  if (!pending.data) return null;
  return (
    <Badge variant="warning" className="ml-auto tabular-nums">
      <span className="sr-only">Awaiting approval: </span>
      {pending.data}
    </Badge>
  );
}
