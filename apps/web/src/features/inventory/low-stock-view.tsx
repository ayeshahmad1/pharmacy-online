import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheckIcon, PackagePlusIcon } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
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
import { formatQuantity } from '@/lib/format';
import { stockStatus } from '@/lib/stock-status';
import { inventoryApi, inventoryKeys } from './inventory-api';
import type { InventoryListParams } from './inventory-page';

/**
 * Active medicines at or below their reorder level, out-of-stock first. Only
 * sellable (non-expired) stock counts, so expiring shelves show up here too.
 */
export function LowStockView({ list: { params, update } }: { list: InventoryListParams }) {
  const query = {
    categoryId: params.filters.categoryId || undefined,
    page: params.page,
    pageSize: params.pageSize,
  };
  const low = useQuery({
    queryKey: inventoryKeys.lowStock(query),
    queryFn: ({ signal }) => inventoryApi.lowStock(query, signal),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <ListToolbar>
        <CategoryFilter
          value={params.filters.categoryId}
          onChange={(categoryId) => update({ categoryId })}
        />
      </ListToolbar>

      <ListView
        query={low}
        filtered={!!params.filters.categoryId}
        onClearFilters={() => update({ categoryId: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={5}
        empty={
          <EmptyState
            icon={CircleCheckIcon}
            title="Nothing to reorder"
            description="Every active medicine has more sellable stock than its reorder level."
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
                    <TableHead className="text-right">Reorder at</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Short by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-32">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((row) => {
                    const status = stockStatus(row);
                    const shortBy = row.medicine.reorderLevel - row.sellableQuantity;
                    return (
                      <TableRow key={row.medicine.id} className={toneRowClass(status.tone)}>
                        <TableCell>
                          <Link
                            to={`/medicines/${row.medicine.id}`}
                            className="font-medium hover:underline"
                          >
                            {row.medicine.name}
                          </Link>
                          {row.medicine.genericName && (
                            <p className="text-xs text-muted-foreground">
                              {row.medicine.genericName}
                            </p>
                          )}
                          {row.expiredQuantity > 0 && (
                            <p className="text-xs text-red-700 dark:text-red-400">
                              + {formatQuantity(row.expiredQuantity, row.medicine.unit)} expired on
                              shelf
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {row.sellableQuantity.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {row.medicine.reorderLevel.toLocaleString()}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums sm:table-cell">
                          {shortBy > 0 ? shortBy.toLocaleString() : '—'}
                        </TableCell>
                        <TableCell>
                          <ToneBadge status={status} />
                        </TableCell>
                        <TableCell>
                          <Button asChild variant="outline" size="sm">
                            <Link to={`/deliveries/new?medicineId=${row.medicine.id}`}>
                              <PackagePlusIcon /> Receive
                            </Link>
                          </Button>
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
