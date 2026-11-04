import {
  writeOffExpiredBodySchema,
  type BatchStockDto,
  type WriteOffExpiredBody,
} from '@pharmacy/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClockIcon, CircleCheckIcon, OctagonAlertIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { Field } from '@/components/form/field';
import { toneRowClass } from '@/components/status-badges';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatDate, formatQuantity } from '@/lib/format';
import { parseForm, type FieldErrors } from '@/lib/form';
import { formatMoney, lineTotal } from '@/lib/money';
import { CorrectExpiryDialog } from './correct-expiry-dialog';
import { inventoryApi, inventoryKeys, invalidateStock } from './inventory-api';
import type { InventoryListParams } from './inventory-page';

/**
 * Expired batches still holding stock. They can never be sold (rule 2); a
 * write-off removes their remaining units with EXPIRED_WRITEOFF movements.
 * A batch whose date was entered wrongly gets its expiry corrected instead.
 */
export function ExpiredView({ list: { params, update } }: { list: InventoryListParams }) {
  const queryClient = useQueryClient();
  const query = { page: params.page, pageSize: params.pageSize };
  const expired = useQuery({
    queryKey: inventoryKeys.expired(query),
    queryFn: ({ signal }) => inventoryApi.expired(query, signal),
    placeholderData: keepPreviousData,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 'selected' writes off the ticked batches; 'all' every expired batch, on any page.
  const [confirming, setConfirming] = useState<'selected' | 'all' | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [correctingExpiry, setCorrectingExpiry] = useState<BatchStockDto | null>(null);

  const pageIds = expired.data?.items.map((b) => b.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const writeOff = useMutation({
    mutationFn: (body: WriteOffExpiredBody) => inventoryApi.writeOffExpired(body),
    onSuccess: async (result) => {
      toast.success(
        `Wrote off ${result.totalQuantity.toLocaleString()} units from ${result.items.length} ${
          result.items.length === 1 ? 'batch' : 'batches'
        }`,
      );
      setConfirming(null);
      setSelected(new Set());
      setReason('');
      await invalidateStock(queryClient);
    },
  });

  function confirm() {
    const parsed = parseForm(writeOffExpiredBodySchema, {
      batchIds: confirming === 'selected' ? [...selected] : undefined,
      reason,
    });
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    writeOff.mutate(parsed.data);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {expired.data && expired.data.total > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 sm:flex-row sm:items-center dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <OctagonAlertIcon className="size-5 shrink-0" />
          <p className="flex-1">
            <strong>{expired.data.total}</strong> expired{' '}
            {expired.data.total === 1 ? 'batch is' : 'batches are'} still on the shelf. Billing will
            not sell them. Remove them from the shelf, then write them off. If a date was entered
            wrongly, fix it with "Fix date".
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={selected.size === 0}
              onClick={() => setConfirming('selected')}
            >
              Write off selected ({selected.size})
            </Button>
            <Button variant="destructive" onClick={() => setConfirming('all')}>
              <Trash2Icon /> Write off all
            </Button>
          </div>
        </div>
      )}

      <ListView
        query={expired}
        filtered={false}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={CircleCheckIcon}
            title="No expired stock"
            description="Every expired batch has been written off."
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <input
                        type="checkbox"
                        className="size-5 accent-primary"
                        aria-label="Select all on this page"
                        checked={allOnPage}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            for (const id of pageIds) {
                              if (allOnPage) next.delete(id);
                              else next.add(id);
                            }
                            return next;
                          })
                        }
                      />
                    </TableHead>
                    <TableHead>Medicine</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead>Expired on</TableHead>
                    <TableHead className="text-right">On shelf</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Cost value</TableHead>
                    <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                    <TableHead className="w-28">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((batch) => {
                    const value = batch.costPrice && lineTotal(batch.costPrice, batch.quantity);
                    return (
                      <TableRow
                        key={batch.id}
                        className={toneRowClass('danger')}
                        data-state={selected.has(batch.id) ? 'selected' : undefined}
                      >
                        <TableCell>
                          <input
                            type="checkbox"
                            className="size-5 accent-primary"
                            aria-label={`Select ${batch.medicine.name} batch ${batch.batchNumber}`}
                            checked={selected.has(batch.id)}
                            onChange={() => toggle(batch.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/medicines/${batch.medicine.id}`}
                            className="font-medium hover:underline"
                          >
                            {batch.medicine.name}
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{batch.batchNumber}</TableCell>
                        <TableCell className="whitespace-nowrap text-red-700 dark:text-red-400">
                          {formatDate(batch.expiryDate)}
                        </TableCell>
                        <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                          {formatQuantity(batch.quantity, batch.medicine.unit)}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">
                          {value ? formatMoney(value) : '—'}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {batch.supplier.name}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCorrectingExpiry(batch)}
                          >
                            <CalendarClockIcon /> Fix date
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

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming === 'all'
            ? `Write off all ${expired.data?.total ?? ''} expired batches?`
            : `Write off ${selected.size} selected ${selected.size === 1 ? 'batch' : 'batches'}?`
        }
        description="Their remaining units are removed from stock. This is recorded in the stock history and cannot be undone."
        confirmLabel="Write off"
        destructive
        pending={writeOff.isPending}
        onConfirm={confirm}
      >
        <Field id="writeoff-reason" label="Note (optional)" error={errors.reason}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Returned to supplier, destroyed"
          />
        </Field>
      </ConfirmDialog>

      {correctingExpiry && (
        <CorrectExpiryDialog
          batch={correctingExpiry}
          onClose={() => {
            setCorrectingExpiry(null);
            // A corrected batch leaves this list; don't write it off by a stale tick.
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
