import type { BatchStockDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarCheckIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { ToneBadge, toneRowClass } from '@/components/status-badges';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate } from '@/lib/format';
import { formatMoney, lineTotal } from '@/lib/money';
import { expiryStatus } from '@/lib/stock-status';
import { AdjustStockDialog } from './adjust-stock-dialog';
import { inventoryApi, inventoryKeys } from './inventory-api';
import type { InventoryListParams } from './inventory-page';

const WINDOWS = [30, 60, 90, 180, 365];

/** Batches with stock that expire within the window, soonest first. */
export function ExpiringView({ list: { params, update } }: { list: InventoryListParams }) {
  const days = Number(params.filters.days) || undefined;
  const query = { days, page: params.page, pageSize: params.pageSize };
  const expiring = useQuery({
    queryKey: inventoryKeys.expiring(query),
    queryFn: ({ signal }) => inventoryApi.expiring(query, signal),
    placeholderData: keepPreviousData,
  });
  const [adjusting, setAdjusting] = useState<BatchStockDto | null>(null);

  // Without a choice the server's own warning window applies; show what it was.
  const shownDays = days ?? expiring.data?.days;
  const windows = shownDays && !WINDOWS.includes(shownDays) ? [...WINDOWS, shownDays] : WINDOWS;

  return (
    <div className="space-y-4">
      <ListToolbar>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Expiring within</span>
          <NativeSelect
            value={shownDays ?? ''}
            onChange={(e) => update({ days: e.target.value })}
            className="w-36"
            aria-label="Expiry window"
          >
            {shownDays === undefined && <option value="">Loading…</option>}
            {windows
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
          </NativeSelect>
        </label>
        {expiring.data && (
          <p className="text-sm text-muted-foreground">
            Up to {formatDate(expiring.data.expiringOnOrBefore)}
          </p>
        )}
      </ListToolbar>

      <ListView
        query={expiring}
        filtered={false}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={CalendarCheckIcon}
            title="Nothing expiring soon"
            description={`No batch with stock expires in the next ${shownDays ?? ''} days.`}
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
                    <TableHead>Batch</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">In stock</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Cost value</TableHead>
                    <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                    <TableHead className="w-28">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((batch) => {
                    const status = expiryStatus(batch);
                    const value = batch.costPrice && lineTotal(batch.costPrice, batch.quantity);
                    return (
                      <TableRow key={batch.id} className={toneRowClass(status.tone)}>
                        <TableCell>
                          <Link
                            to={`/medicines/${batch.medicine.id}`}
                            className="font-medium hover:underline"
                          >
                            {batch.medicine.name}
                          </Link>
                          {batch.medicine.genericName && (
                            <p className="text-xs text-muted-foreground">
                              {batch.medicine.genericName}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{batch.batchNumber}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span className="whitespace-nowrap">
                              {formatDate(batch.expiryDate)}
                            </span>
                            <ToneBadge status={status} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                          {batch.quantity.toLocaleString()}{' '}
                          <span className="text-xs font-normal text-muted-foreground">
                            {batch.medicine.unit}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">
                          {value ? formatMoney(value) : '—'}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {batch.supplier.name}
                        </TableCell>
                        <TableCell>
                          <Button variant="outline" size="sm" onClick={() => setAdjusting(batch)}>
                            <SlidersHorizontalIcon /> Adjust
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

      {adjusting && <AdjustStockDialog batch={adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  );
}
