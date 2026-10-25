import {
  OFFLINE_CONFLICT_STATUSES,
  type OfflineConflictStatus,
  type OfflineSaleConflictDto,
} from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2Icon, CloudOffIcon, RefreshCwIcon, SaveIcon, XCircleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar, PageIntro } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { Badge } from '@/components/ui/badge';
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
import { useCurrentUser } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { offlineApi, offlineKeys } from '@/offline/offline-api';
import { useOffline } from '@/offline/offline-context';
import { offlineRef, saleQueue, type QueuedSale } from '@/offline/sale-queue';
import { DismissConflictDialog, RetryConflictDialog, conflictAdvice } from './conflict-dialogs';

const units = (items: { quantity: number }[]) => items.reduce((sum, i) => sum + i.quantity, 0);

function QueueStatusBadge({ sale }: { sale: QueuedSale }) {
  switch (sale.status) {
    case 'pending':
      return <Badge variant="warning">{sale.lastError ? 'Retrying' : 'Waiting to sync'}</Badge>;
    case 'flagged':
      return (
        <Badge variant="danger">
          {sale.conflictId ? 'Flagged for review' : 'Flagged, reporting…'}
        </Badge>
      );
    case 'synced':
      return <Badge variant="success">Synced</Badge>;
    case 'resolved':
      return <Badge variant="success">Saved on review</Badge>;
    case 'dismissed':
      return <Badge variant="secondary">Dismissed</Badge>;
  }
}

const CONFLICT_LABELS: Record<OfflineConflictStatus, string> = {
  OPEN: 'Needs review',
  RESOLVED: 'Saved',
  DISMISSED: 'Dismissed',
};

function ConflictStatusBadge({ status }: { status: OfflineConflictStatus }) {
  const variant = status === 'OPEN' ? 'danger' : status === 'RESOLVED' ? 'success' : 'secondary';
  return <Badge variant={variant}>{CONFLICT_LABELS[status]}</Badge>;
}

/** This device's queue for the signed-in user, newest first. */
function DeviceQueue() {
  const user = useCurrentUser();
  const offline = useOffline();
  const [sales, setSales] = useState<QueuedSale[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      saleQueue
        .list()
        .then((all) => !cancelled && setSales(all.filter((s) => s.userId === user.id).reverse()))
        .catch(() => !cancelled && setSales([]));
    void load();
    const unsubscribe = saleQueue.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user.id]);

  return (
    <section className="space-y-3">
      <ListToolbar
        actions={
          <Button
            variant="outline"
            disabled={
              !offline.canSync ||
              offline.syncing ||
              offline.summary.pending + offline.summary.flagged === 0
            }
            onClick={offline.syncNow}
          >
            <RefreshCwIcon className={offline.syncing ? 'animate-spin' : undefined} /> Sync now
          </Button>
        }
      >
        <PageIntro
          title="On this device"
          description={
            offline.online
              ? 'Your sales made offline. Waiting ones are sent automatically.'
              : 'Offline: these wait here and are sent automatically when the connection returns.'
          }
        />
      </ListToolbar>
      {offline.summary.othersPending > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {offline.summary.othersPending} sale(s) by other users are also waiting on this device.
          They sync when those users log in here.
        </p>
      )}
      {sales && sales.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No offline sales on this device.
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sold</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead className="hidden sm:table-cell">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sales ?? []).map((sale) => (
                <TableRow key={sale.idempotencyKey}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(sale.body.offline?.soldAt ?? sale.queuedAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {sale.sale?.receiptNumber ?? offlineRef(sale.idempotencyKey)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{units(sale.body.items)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMoney(sale.receipt.grandTotal)}
                  </TableCell>
                  <TableCell>
                    <QueueStatusBadge sale={sale} />
                    {sale.lastError &&
                      !['synced', 'resolved', 'dismissed'].includes(sale.status) && (
                        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                          {sale.lastError.message}
                        </p>
                      )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/** Sales the server refused, for review. Cashiers see their own, read-only. */
function FlaggedSales() {
  const user = useCurrentUser();
  const canReview = STAFF_ROLES.includes(user.role);
  const { params, update } = useListParams(['status'], { status: 'OPEN' });
  const status = OFFLINE_CONFLICT_STATUSES.find((s) => s === params.filters.status);
  const query = { status, page: params.page, pageSize: params.pageSize };
  const conflicts = useQuery({
    queryKey: offlineKeys.conflicts(query),
    queryFn: ({ signal }) => offlineApi.listConflicts(query, signal),
    placeholderData: keepPreviousData,
    // Fail (with a retry button) rather than wait silently while offline.
    networkMode: 'always',
  });
  const [retrying, setRetrying] = useState<OfflineSaleConflictDto | null>(null);
  const [dismissing, setDismissing] = useState<OfflineSaleConflictDto | null>(null);

  return (
    <section className="space-y-3">
      <ListToolbar
        actions={
          <NativeSelect
            value={params.filters.status}
            onChange={(e) => update({ status: e.target.value })}
            aria-label="Status"
            className="w-full sm:w-40"
          >
            <option value="OPEN">Needs review</option>
            <option value="RESOLVED">Saved</option>
            <option value="DISMISSED">Dismissed</option>
            <option value="all">All</option>
          </NativeSelect>
        }
      >
        <PageIntro
          title="Flagged for review"
          description={
            canReview
              ? 'Offline sales the server refused at sync (stock gone, price changed, discount over the cashier limit). Nothing was saved for them: fix the cause and save each one, or dismiss it with a reason.'
              : 'Your offline sales the server refused at sync. A pharmacist or admin will review them.'
          }
        />
      </ListToolbar>

      <ListView
        query={conflicts}
        filtered={params.filters.status !== 'OPEN'}
        onClearFilters={() => update({ status: 'OPEN' })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={CheckCircle2Icon}
            title="Nothing to review"
            description="Offline sales that the server refuses at sync will appear here."
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sold</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Charged</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    {canReview && (
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((c) => (
                    <TableRow key={c.id} className="align-top">
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(c.soldAt)}
                        <p className="text-xs text-muted-foreground">{c.cashier.fullName}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {offlineRef(c.idempotencyKey)}
                        </p>
                      </TableCell>
                      <TableCell className="min-w-36 whitespace-normal">
                        <ul className="space-y-0.5 text-sm">
                          {c.items.map((i) => (
                            <li key={i.medicineId}>
                              {i.name ?? 'Unknown medicine'} × {i.quantity}
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {formatMoney(c.expectedTotal)}
                      </TableCell>
                      <TableCell className="min-w-64 max-w-md text-sm whitespace-normal">
                        {c.status === 'DISMISSED' ? (
                          <>Dismissed: {c.dismissReason}</>
                        ) : c.status === 'RESOLVED' ? (
                          <>Saved as {c.sale?.receiptNumber}</>
                        ) : (
                          <>
                            {c.error.message}
                            {canReview && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {conflictAdvice(c)}
                              </p>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <ConflictStatusBadge status={c.status} />
                        {c.attempts > 1 && (
                          <p className="mt-1 text-xs text-muted-foreground">{c.attempts} tries</p>
                        )}
                        {c.resolvedBy && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            by {c.resolvedBy.fullName}
                          </p>
                        )}
                      </TableCell>
                      {canReview && (
                        <TableCell>
                          {c.status === 'OPEN' && (
                            <div className="flex flex-col gap-2 sm:flex-row">
                              <Button size="sm" onClick={() => setRetrying(c)}>
                                <SaveIcon /> Save
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setDismissing(c)}>
                                <XCircleIcon /> Dismiss
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      )}
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

      {retrying && <RetryConflictDialog conflict={retrying} onClose={() => setRetrying(null)} />}
      {dismissing && (
        <DismissConflictDialog conflict={dismissing} onClose={() => setDismissing(null)} />
      )}
    </section>
  );
}

/** Sales made offline: what this device still has to send, and what the server refused. */
export function OfflineSalesPage() {
  const offline = useOffline();
  return (
    <div className="space-y-8">
      {!offline.online && (
        <p className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <CloudOffIcon className="size-5 shrink-0" />
          Offline. The review list needs the server; this device’s sales are below.
        </p>
      )}
      <DeviceQueue />
      <FlaggedSales />
    </div>
  );
}
