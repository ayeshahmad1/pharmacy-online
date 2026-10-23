import { useQuery } from '@tanstack/react-query';
import { PackagePlusIcon } from 'lucide-react';
import { Link } from 'react-router';
import { PageIntro, STATUS_FILTER_DEFAULT } from '@/components/data/filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useListParams } from '@/lib/list-params';
import { cn } from '@/lib/utils';
import { ExpiredView } from './expired-view';
import { ExpiringView } from './expiring-view';
import { inventoryApi, inventoryKeys } from './inventory-api';
import { LowStockView } from './low-stock-view';
import { StockView } from './stock-view';

const VIEWS = [
  { id: 'stock', label: 'All stock' },
  { id: 'low', label: 'Low stock', tone: 'warning' },
  { id: 'expiring', label: 'Expiring soon', tone: 'warning' },
  { id: 'expired', label: 'Expired', tone: 'danger' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

const FILTERS = ['view', 'status', 'categoryId', 'days'] as const;
// No default `days`: the expiring list then uses the server's EXPIRY_WARNING_DAYS,
// the same window the tab badge counts.
const DEFAULTS = { view: 'stock', status: STATUS_FILTER_DEFAULT };

export type InventoryListParams = ReturnType<typeof useInventoryParams>;

function useInventoryParams() {
  return useListParams(FILTERS, DEFAULTS);
}

export function InventoryPage() {
  const list = useInventoryParams();
  const view = (
    VIEWS.some((v) => v.id === list.params.filters.view) ? list.params.filters.view : 'stock'
  ) as ViewId;
  const counts = useWarningCounts();

  function switchView(next: ViewId) {
    // Each view has its own filters; start the new one clean.
    list.update({ view: next, q: '', status: '', categoryId: '', days: '', pageSize: '' });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageIntro description="Stock on hand is the sum of every batch's movements. Expired batches are never sold." />
        <Button asChild className="shrink-0">
          <Link to="/inventory/receive">
            <PackagePlusIcon /> Receive stock
          </Link>
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="Inventory views"
        className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
      >
        {VIEWS.map((v) => {
          const count = v.id === 'stock' ? undefined : counts[v.id];
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => switchView(v.id)}
              className={cn(
                'flex h-10 shrink-0 items-center gap-2 rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors',
                view === v.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.label}
              {count !== undefined && count > 0 && 'tone' in v && (
                <Badge variant={v.tone} className="min-w-6 tabular-nums">
                  {count > 999 ? '999+' : count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {view === 'stock' && <StockView list={list} />}
        {view === 'low' && <LowStockView list={list} />}
        {view === 'expiring' && <ExpiringView list={list} />}
        {view === 'expired' && <ExpiredView list={list} />}
      </div>
    </div>
  );
}

/** How many items each warning list holds, for the tab badges. One-row pages keep it cheap. */
function useWarningCounts(): Partial<Record<ViewId, number>> {
  const one = { page: 1, pageSize: 1 };
  const low = useQuery({
    queryKey: inventoryKeys.lowStock({ ...one, count: true }),
    queryFn: ({ signal }) => inventoryApi.lowStock(one, signal),
  });
  const expiring = useQuery({
    queryKey: inventoryKeys.expiring({ ...one, count: true }),
    queryFn: ({ signal }) => inventoryApi.expiring(one, signal),
  });
  const expired = useQuery({
    queryKey: inventoryKeys.expired({ ...one, count: true }),
    queryFn: ({ signal }) => inventoryApi.expired(one, signal),
  });
  return { low: low.data?.total, expiring: expiring.data?.total, expired: expired.data?.total };
}
