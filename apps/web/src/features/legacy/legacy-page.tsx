import type { LegacyPurchaseDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArchiveIcon } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar, PageIntro } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { legacyApi, legacyKeys } from './legacy-api';

const VIEWS = [
  { id: 'returns', label: 'Returns' },
  { id: 'deliveries', label: 'Deliveries' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

const FILTERS = ['view', 'from', 'to'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type LegacyListParams = ReturnType<typeof useLegacyParams>;

function useLegacyParams() {
  return useListParams(FILTERS, { view: 'returns' });
}

/**
 * Returns and deliveries recorded by the old system, loaded at the migration.
 * History only: they never changed stock here and no report counts them.
 */
export function LegacyPage() {
  const list = useLegacyParams();
  const { params, update } = list;
  const view: ViewId = params.filters.view === 'deliveries' ? 'deliveries' : 'returns';

  // Hand-edited URLs or a from after to: drop or swap rather than fail the list.
  let from = DATE.test(params.filters.from) ? params.filters.from : '';
  let to = DATE.test(params.filters.to) ? params.filters.to : '';
  if (from && to && from > to) [from, to] = [to, from];
  const filters = { q: params.q || undefined, from: from || undefined, to: to || undefined };

  return (
    <div className="space-y-4">
      <PageIntro description="Returns and deliveries recorded by the old system before the switch. They are kept for reference only: they never changed stock here and no report counts them." />

      <div
        role="tablist"
        aria-label="Old system records"
        className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => update({ view: v.id })}
            className={cn(
              'flex h-10 shrink-0 items-center rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors',
              view === v.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <ListToolbar>
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search medicine or generic name"
          className="sm:w-72"
        />
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="From date"
            value={from}
            max={to || undefined}
            onChange={(e) => update({ from: e.target.value })}
            className="w-full sm:w-40"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="To date"
            value={to}
            min={from || undefined}
            onChange={(e) => update({ to: e.target.value })}
            className="w-full sm:w-40"
          />
        </div>
      </ListToolbar>

      <div role="tabpanel">
        {view === 'returns' ? (
          <ReturnsView list={list} filters={filters} />
        ) : (
          <DeliveriesView list={list} filters={filters} />
        )}
      </div>
    </div>
  );
}

type ViewProps = {
  list: LegacyListParams;
  filters: { q?: string; from?: string; to?: string };
};

const emptyState = (what: string) => (
  <EmptyState
    icon={ArchiveIcon}
    title={`No ${what} from the old system`}
    description="They appear here once the old system's data has been migrated."
  />
);

function ReturnsView({ list: { params, update }, filters }: ViewProps) {
  const query = { ...filters, page: params.page, pageSize: params.pageSize };
  const returns = useQuery({
    queryKey: legacyKeys.returns(query),
    queryFn: ({ signal }) => legacyApi.returns(query, signal),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  return (
    <ListView
      query={returns}
      filtered={!!(filters.q || filters.from || filters.to)}
      onClearFilters={() => update({ q: '', from: '', to: '' })}
      onFirstPage={() => update({ page: 1 })}
      columns={4}
      empty={emptyState('returns')}
    >
      {(data) => (
        <div className="space-y-3">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Returned</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead className="hidden md:table-cell">Recorded by</TableHead>
                  <TableHead className="text-right">Refund</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(r.returnedAt)}
                    </TableCell>
                    <TableCell>
                      <ul className="space-y-1">
                        {r.items.map((item) => (
                          <li key={item.lineNo} className="flex flex-wrap gap-x-2">
                            <Link
                              to={`/medicines/${item.medicine.id}`}
                              className="font-medium hover:underline"
                            >
                              {item.medicine.name}
                            </Link>
                            <span className="text-muted-foreground tabular-nums">
                              {item.quantity} × {formatMoney(item.unitPrice)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{r.cashier.fullName}</TableCell>
                    <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                      {formatMoney(r.refundTotal)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={(page) => update({ page })}
            onPageSizeChange={(pageSize) => update({ pageSize })}
          />
        </div>
      )}
    </ListView>
  );
}

function DeliveriesView({ list: { params, update }, filters }: ViewProps) {
  const query = { ...filters, page: params.page, pageSize: params.pageSize };
  const deliveries = useQuery({
    queryKey: legacyKeys.purchases(query),
    queryFn: ({ signal }) => legacyApi.purchases(query, signal),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  return (
    <ListView
      query={deliveries}
      filtered={!!(filters.q || filters.from || filters.to)}
      onClearFilters={() => update({ q: '', from: '', to: '' })}
      onFirstPage={() => update({ page: 1 })}
      columns={6}
      empty={emptyState('deliveries')}
    >
      {(data) => (
        <div className="space-y-3">
          <div className="rounded-lg border">
            <PurchasesTable items={data.items} showMedicine />
          </div>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={(page) => update({ page })}
            onPageSizeChange={(pageSize) => update({ pageSize })}
          />
        </div>
      )}
    </ListView>
  );
}

/** Old deliveries; also used on a medicine's page, where the medicine column is dropped. */
export function PurchasesTable({
  items,
  showMedicine = false,
}: {
  items: LegacyPurchaseDto[];
  showMedicine?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Received</TableHead>
          {showMedicine && <TableHead>Medicine</TableHead>}
          <TableHead className="hidden sm:table-cell">Batch</TableHead>
          <TableHead className="hidden lg:table-cell">Supplier</TableHead>
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead className="text-right">Paid</TableHead>
          <TableHead className="hidden text-right md:table-cell">Per unit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="whitespace-nowrap">{formatDateTime(p.purchasedAt)}</TableCell>
            {showMedicine && (
              <TableCell>
                <Link to={`/medicines/${p.medicine.id}`} className="font-medium hover:underline">
                  {p.medicine.name}
                </Link>
              </TableCell>
            )}
            <TableCell className="hidden font-mono text-xs sm:table-cell">
              {p.batch.batchNumber}
            </TableCell>
            <TableCell className="hidden lg:table-cell">{p.supplier.name}</TableCell>
            <TableCell className="text-right tabular-nums">{p.quantity.toLocaleString()}</TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {p.totalCost ? (
                formatMoney(p.totalCost)
              ) : (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </TableCell>
            <TableCell className="hidden text-right whitespace-nowrap tabular-nums md:table-cell">
              {p.unitCost ? formatMoney(p.unitCost) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
