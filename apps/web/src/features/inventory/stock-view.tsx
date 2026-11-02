import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BoxesIcon, PackagePlusIcon } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import {
  ListToolbar,
  STATUS_FILTER_DEFAULT,
  StatusFilter,
  statusQuery,
} from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { ToneBadge, toneRowClass } from '@/components/status-badges';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CategoryFilter } from '@/features/catalog/category-filter';
import { formatDate } from '@/lib/format';
import { daysUntil, expiryStatus, stockStatus } from '@/lib/stock-status';
import { cn } from '@/lib/utils';
import { inventoryApi, inventoryKeys } from './inventory-api';
import type { InventoryListParams } from './inventory-page';

/** Every medicine with its stock totals, alphabetically. */
export function StockView({ list: { params, update } }: { list: InventoryListParams }) {
  const query = {
    q: params.q || undefined,
    categoryId: params.filters.categoryId || undefined,
    status: statusQuery(params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const stock = useQuery({
    queryKey: inventoryKeys.stock(query),
    queryFn: ({ signal }) => inventoryApi.stock(query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered =
    !!params.q || !!params.filters.categoryId || params.filters.status !== STATUS_FILTER_DEFAULT;

  return (
    <div className="space-y-4">
      <ListToolbar>
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search brand or generic name"
          className="sm:w-80"
          autoFocus
        />
        <CategoryFilter
          value={params.filters.categoryId}
          onChange={(categoryId) => update({ categoryId })}
        />
        <StatusFilter value={params.filters.status} onChange={(status) => update({ status })} />
      </ListToolbar>

      <ListView
        query={stock}
        filtered={filtered}
        onClearFilters={() => update({ q: '', categoryId: '', status: STATUS_FILTER_DEFAULT })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={BoxesIcon}
            title="No medicines in the catalogue"
            description="Add medicines first, then receive stock for them."
            action={
              <Button asChild>
                <Link to="/medicines">Go to medicines</Link>
              </Button>
            }
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medicine</TableHead>
                    <TableHead className="text-right">Sellable</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Reorder at</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Expired</TableHead>
                    <TableHead className="hidden lg:table-cell">Next expiry</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((row) => {
                    const status = stockStatus(row);
                    const next = row.nextExpiry
                      ? expiryStatus({ isExpired: false, daysToExpiry: daysUntil(row.nextExpiry) })
                      : null;
                    return (
                      <TableRow
                        key={row.medicine.id}
                        className={cn(
                          row.medicine.status === 'ACTIVE' && toneRowClass(status.tone),
                        )}
                      >
                        <TableCell>
                          <Link
                            to={`/medicines/${row.medicine.id}`}
                            className="font-medium hover:underline"
                          >
                            {row.medicine.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {row.medicine.genericName ?? ''}
                            {row.medicine.status === 'INACTIVE' && ' · inactive'}
                          </p>
                        </TableCell>
                        <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                          {row.sellableQuantity.toLocaleString()}{' '}
                          <span className="text-xs font-normal text-muted-foreground">
                            {row.medicine.unit}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                          {row.medicine.reorderLevel}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'hidden text-right tabular-nums md:table-cell',
                            row.expiredQuantity > 0
                              ? 'font-medium text-red-700 dark:text-red-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          {row.expiredQuantity.toLocaleString()}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {row.nextExpiry && next ? (
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              {formatDate(row.nextExpiry)}
                              <ToneBadge status={next} hideOk />
                            </div>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell>
                          <ToneBadge status={status} />
                        </TableCell>
                        <TableCell>
                          {row.medicine.status === 'ACTIVE' && (
                            <Button
                              asChild
                              variant="ghost"
                              size="icon"
                              aria-label={`Receive stock for ${row.medicine.name}`}
                              title="Receive stock"
                            >
                              <Link to={`/deliveries/new?medicineId=${row.medicine.id}`}>
                                <PackagePlusIcon className="size-5" />
                              </Link>
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
    </div>
  );
}
