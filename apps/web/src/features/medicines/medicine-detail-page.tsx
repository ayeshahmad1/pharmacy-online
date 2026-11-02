import type { BatchStockDto, MedicineDto, MedicineStockDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BoxesIcon,
  HistoryIcon,
  PackagePlusIcon,
  PencilIcon,
  PowerIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ErrorState, TableSkeleton } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { RecordStatusBadge, ToneBadge, toneRowClass } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActivationDialog, type ActivationTarget } from '@/features/catalog/activation-dialog';
import { catalogKeys, medicinesApi } from '@/features/catalog/catalog-api';
import { AdjustStockDialog } from '@/features/inventory/adjust-stock-dialog';
import { inventoryApi, inventoryKeys } from '@/features/inventory/inventory-api';
import { MOVEMENT_LABELS } from '@/features/inventory/movement-labels';
import { legacyApi, legacyKeys } from '@/features/legacy/legacy-api';
import { PurchasesTable } from '@/features/legacy/legacy-page';
import { ApiError } from '@/lib/api';
import { formatChange, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { expiryStatus, stockStatus } from '@/lib/stock-status';
import { cn } from '@/lib/utils';
import { MedicineFormDialog } from './medicine-form-dialog';

export function MedicineDetailPage() {
  const { id = '' } = useParams();
  const medicine = useQuery({
    queryKey: [...catalogKeys.medicines, 'detail', id],
    queryFn: ({ signal }) => medicinesApi.get(id, signal),
  });

  const [editing, setEditing] = useState(false);
  const [activation, setActivation] = useState<ActivationTarget | null>(null);

  if (medicine.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <TableSkeleton rows={3} />
      </div>
    );
  }
  if (medicine.isError) {
    const missing =
      medicine.error instanceof ApiError &&
      (medicine.error.status === 404 || medicine.error.code === 'VALIDATION_ERROR');
    return missing ? (
      <EmptyState
        icon={SearchXIcon}
        title="Medicine not found"
        description="It may have been mistyped in the address. Medicines are never deleted."
        action={
          <Button asChild variant="outline">
            <Link to="/medicines">Back to medicines</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState
        error={medicine.error}
        onRetry={() => void medicine.refetch()}
        retrying={medicine.isFetching}
      />
    );
  }

  const m = medicine.data;
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/medicines">
            <ArrowLeftIcon /> Medicines
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold">{m.name}</h2>
              <RecordStatusBadge status={m.status} />
            </div>
            <p className="text-muted-foreground">{m.genericName ?? 'No generic name recorded'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {m.status === 'ACTIVE' && (
              <Button asChild>
                <Link to={`/deliveries/new?medicineId=${m.id}`}>
                  <PackagePlusIcon /> Receive stock
                </Link>
              </Button>
            )}
            <Button variant="outline" onClick={() => setEditing(true)}>
              <PencilIcon /> Edit
            </Button>
            <Button variant="outline" onClick={() => setActivation(m)}>
              <PowerIcon /> {m.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
            </Button>
          </div>
        </div>
      </div>

      <MedicineFacts medicine={m} />
      <StockSection medicine={m} />
      <MovementsSection medicineId={m.id} />
      <OldDeliveriesSection medicineId={m.id} />

      {editing && <MedicineFormDialog open onOpenChange={setEditing} medicine={m} />}
      <ActivationDialog
        entity="medicine"
        target={activation}
        onClose={() => setActivation(null)}
        setActive={medicinesApi.setActive}
      />
    </div>
  );
}

function MedicineFacts({ medicine: m }: { medicine: MedicineDto }) {
  const facts: [string, ReactNode][] = [
    ['Category', m.category.name],
    ['Unit', <span className="capitalize">{m.unit}</span>],
    ['Selling price', <span className="tabular-nums">{formatMoney(m.sellingPrice)}</span>],
    ['Reorder level', formatQuantity(m.reorderLevel, m.unit)],
    ['Barcode', m.barcode ? <span className="font-mono">{m.barcode}</span> : '—'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-5">
      {facts.map(([label, value]) => (
        <div key={label} className="space-y-1">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StockSection({ medicine }: { medicine: MedicineDto }) {
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [adjusting, setAdjusting] = useState<BatchStockDto | null>(null);
  const stock = useQuery({
    queryKey: inventoryKeys.medicine(medicine.id, includeEmpty),
    queryFn: ({ signal }) => inventoryApi.medicineStock(medicine.id, includeEmpty, signal),
    placeholderData: keepPreviousData,
  });

  return (
    <section className="space-y-3" aria-labelledby="stock-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="stock-heading" className="flex items-center gap-2 text-lg font-semibold">
          <BoxesIcon className="size-5" /> Stock
        </h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={includeEmpty}
            onChange={(e) => setIncludeEmpty(e.target.checked)}
          />
          Show empty batches
        </label>
      </div>

      {stock.isPending ? (
        <TableSkeleton rows={3} />
      ) : stock.isError ? (
        <ErrorState
          error={stock.error}
          onRetry={() => void stock.refetch()}
          retrying={stock.isFetching}
        />
      ) : (
        <>
          <StockSummary stock={stock.data} />
          {stock.data.batches.length === 0 ? (
            <EmptyState
              icon={BoxesIcon}
              title={includeEmpty ? 'No batches received yet' : 'No stock on hand'}
              description="Receive a delivery to add a batch with its expiry date and cost."
              action={
                medicine.status === 'ACTIVE' && (
                  <Button asChild>
                    <Link to={`/deliveries/new?medicineId=${medicine.id}`}>
                      <PackagePlusIcon /> Receive stock
                    </Link>
                  </Button>
                )
              }
            />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead className="text-right">In stock</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Received</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Cost</TableHead>
                    <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                    <TableHead className="w-28">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stock.data.batches.map((batch, index) => {
                    const expiry = expiryStatus(batch);
                    const sellsNext =
                      index === stock.data.batches.findIndex((b) => !b.isExpired && b.quantity > 0);
                    return (
                      <TableRow
                        key={batch.id}
                        className={cn(batch.quantity > 0 && toneRowClass(expiry.tone))}
                      >
                        <TableCell>
                          <span className="font-mono font-medium">{batch.batchNumber}</span>
                          {sellsNext && (
                            <Badge variant="outline" className="ml-2" title="Sold first (FEFO)">
                              Sells next
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span className="whitespace-nowrap">
                              {formatDate(batch.expiryDate)}
                            </span>
                            <ToneBadge status={expiry} hideOk />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {batch.quantity.toLocaleString()}
                        </TableCell>
                        <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                          {batch.quantityReceived.toLocaleString()}
                          <p className="text-xs">{formatDateTime(batch.receivedAt)}</p>
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">
                          {batch.costPrice ? formatMoney(batch.costPrice) : '—'}
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
          )}
        </>
      )}

      {adjusting && <AdjustStockDialog batch={adjusting} onClose={() => setAdjusting(null)} />}
    </section>
  );
}

function StockSummary({ stock }: { stock: MedicineStockDto }) {
  const unit = stock.medicine.unit;
  const status = stockStatus(stock);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Sellable stock
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 px-4">
          <span className="text-2xl font-semibold tabular-nums">
            {formatQuantity(stock.sellableQuantity, unit)}
          </span>
          <ToneBadge status={status} />
        </CardContent>
      </Card>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Expired on shelf
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 px-4">
          <span
            className={cn(
              'text-2xl font-semibold tabular-nums',
              stock.expiredQuantity > 0 && 'text-red-700 dark:text-red-400',
            )}
          >
            {formatQuantity(stock.expiredQuantity, unit)}
          </span>
          {stock.expiredQuantity > 0 && (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link to="/inventory?view=expired">Write off</Link>
            </Button>
          )}
        </CardContent>
      </Card>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">Next expiry</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <span className="text-2xl font-semibold">
            {stock.nextExpiry ? formatDate(stock.nextExpiry) : '—'}
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Deliveries the old system recorded (rule 15). History only: they're already
 * part of the opening stock. Hidden for medicines added after the switch.
 */
function OldDeliveriesSection({ medicineId }: { medicineId: string }) {
  const [page, setPage] = useState(1);
  const query = { medicineId, page, pageSize: 10 };
  const deliveries = useQuery({
    queryKey: legacyKeys.purchases(query),
    queryFn: ({ signal }) => legacyApi.purchases(query, signal),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  if (deliveries.isPending || (deliveries.isSuccess && deliveries.data.total === 0)) return null;

  return (
    <section className="space-y-3" aria-labelledby="old-deliveries-heading">
      <div className="space-y-1">
        <h3 id="old-deliveries-heading" className="flex items-center gap-2 text-lg font-semibold">
          <ArchiveIcon className="size-5" /> Deliveries in the old system
        </h3>
        <p className="text-sm text-muted-foreground">
          For reference: these are already included in the opening stock and change nothing.
        </p>
      </div>
      {deliveries.isError ? (
        <ErrorState
          error={deliveries.error}
          onRetry={() => void deliveries.refetch()}
          retrying={deliveries.isFetching}
        />
      ) : (
        <div className={cn('space-y-3', deliveries.isPlaceholderData && 'opacity-60')}>
          <div className="rounded-lg border">
            <PurchasesTable items={deliveries.data.items} />
          </div>
          <Pagination
            page={deliveries.data.page}
            pageSize={deliveries.data.pageSize}
            total={deliveries.data.total}
            onPageChange={setPage}
          />
        </div>
      )}
    </section>
  );
}

function MovementsSection({ medicineId }: { medicineId: string }) {
  const [page, setPage] = useState(1);
  const query = { medicineId, page, pageSize: 10 };
  const movements = useQuery({
    queryKey: inventoryKeys.movements(query),
    queryFn: ({ signal }) => inventoryApi.movements(query, signal),
    placeholderData: keepPreviousData,
  });

  return (
    <section className="space-y-3" aria-labelledby="movements-heading">
      <h3 id="movements-heading" className="flex items-center gap-2 text-lg font-semibold">
        <HistoryIcon className="size-5" /> Stock history
      </h3>
      {movements.isPending ? (
        <TableSkeleton rows={3} />
      ) : movements.isError ? (
        <ErrorState
          error={movements.error}
          onRetry={() => void movements.refetch()}
          retrying={movements.isFetching}
        />
      ) : movements.data.total === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No stock movements yet.
        </p>
      ) : (
        <div className={cn('space-y-3', movements.isPlaceholderData && 'opacity-60')}>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                  <TableHead className="hidden md:table-cell">Reason</TableHead>
                  <TableHead className="hidden sm:table-cell">By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.data.items.map((mv) => (
                  <TableRow key={mv.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(mv.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{MOVEMENT_LABELS[mv.type]}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{mv.batch.batchNumber}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-medium tabular-nums',
                        mv.quantity > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-700 dark:text-red-400',
                      )}
                    >
                      {formatChange(mv.quantity)}
                    </TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                      {mv.reason ?? '—'}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{mv.user.fullName}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination
            page={movements.data.page}
            pageSize={movements.data.pageSize}
            total={movements.data.total}
            onPageChange={setPage}
          />
        </div>
      )}
    </section>
  );
}
