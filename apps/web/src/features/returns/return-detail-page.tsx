import type { ReturnDto } from '@pharmacy/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ClockIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { BackLink, DetailError, DetailSkeleton, Facts } from '@/components/data/detail-states';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCurrentUser } from '@/features/auth/auth-context';
import { PAYMENT_LABELS } from '@/features/billing/payments';
import { invalidateAfterSaleChange } from '@/features/sales/sales-api';
import { ReturnStatusBadge } from '@/features/sales/status-badges';
import { formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { RejectReturnDialog } from './reject-return-dialog';
import { returnsApi, returnsKeys } from './returns-api';

export function ReturnDetailPage() {
  const { id = '' } = useParams();
  const ret = useQuery({
    queryKey: returnsKeys.detail(id),
    queryFn: ({ signal }) => returnsApi.get(id, signal),
  });

  if (ret.isPending) return <DetailSkeleton />;
  if (ret.isError) {
    return (
      <DetailError
        error={ret.error}
        onRetry={() => void ret.refetch()}
        retrying={ret.isFetching}
        missingTitle="Return not found"
        missingDescription="Check the return number. Cashiers can only open the returns they raised."
        backTo="/returns"
        backLabel="Back to returns"
      />
    );
  }
  return <ReturnDetail ret={ret.data} />;
}

function ReturnDetail({ ret }: { ret: ReturnDto }) {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const pending = ret.status === 'PENDING';
  // Only a completed return moved stock and money; otherwise these are what was asked for.
  const done = ret.status === 'COMPLETED';
  const restocked = ret.items.filter((i) => i.restock).reduce((sum, i) => sum + i.quantity, 0);

  const approve = useMutation({
    mutationFn: () => returnsApi.approve(ret.id),
    onSuccess: async (approved) => {
      toast.success(
        `Return ${approved.returnNumber} approved: refund ${formatMoney(approved.refundTotal)}`,
      );
      setApproving(false);
      await invalidateAfterSaleChange(queryClient);
    },
    onError: () => {
      setApproving(false);
      void invalidateAfterSaleChange(queryClient);
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink to="/returns">Returns</BackLink>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-2xl font-semibold">{ret.returnNumber}</h2>
              <ReturnStatusBadge status={ret.status} />
            </div>
            <p className="text-muted-foreground">
              Against sale{' '}
              {isStaff ? (
                <Link to={`/sales/${ret.sale.id}`} className="font-mono hover:underline">
                  {ret.sale.receiptNumber}
                </Link>
              ) : (
                <span className="font-mono">{ret.sale.receiptNumber}</span>
              )}{' '}
              of {formatDateTime(ret.sale.soldAt)}
            </p>
          </div>
          {pending && isStaff && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setApproving(true)}>
                <CheckIcon /> Approve
              </Button>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setRejecting(true)}
              >
                <XIcon /> Reject
              </Button>
            </div>
          )}
        </div>
      </div>

      {pending && !isStaff && (
        <p className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <ClockIcon className="size-5 shrink-0" />
          Waiting for a pharmacist or admin to approve it. Hand over the refund once it is approved.
        </p>
      )}
      {ret.status === 'REJECTED' && (
        <div className="rounded-lg border p-4 text-sm">
          <p className="font-medium">
            Rejected
            {ret.reviewedBy && ` by ${ret.reviewedBy.fullName}`}
            {ret.reviewedAt && `, ${formatDateTime(ret.reviewedAt)}`}
          </p>
          {ret.rejectionReason && <p className="mt-1">Reason: {ret.rejectionReason}</p>}
          <p className="mt-1 text-muted-foreground">
            Nothing moved and nothing was refunded. The units can be returned again.
          </p>
        </div>
      )}

      <Facts
        items={[
          [
            done ? 'Refunded' : 'Refund requested',
            <span className="tabular-nums">{formatMoney(ret.refundTotal)}</span>,
          ],
          ['Units', ret.itemCount],
          ['Raised', `${formatDateTime(ret.requestedAt)} by ${ret.requestedBy.fullName}`],
          [
            pending ? 'Review' : 'Reviewed',
            pending
              ? 'Awaiting approval'
              : ret.reviewedBy
                ? `${ret.reviewedAt ? formatDateTime(ret.reviewedAt) : ''} by ${ret.reviewedBy.fullName}`
                : '—',
          ],
        ]}
      />
      <section className="space-y-1" aria-labelledby="return-reason-heading">
        <h3 id="return-reason-heading" className="text-sm text-muted-foreground">
          Reason for the return
        </h3>
        <p className="whitespace-pre-wrap">{ret.reason}</p>
      </section>

      <section className="space-y-3" aria-labelledby="return-items-heading">
        <h3 id="return-items-heading" className="text-lg font-semibold">
          Items
        </h3>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Medicine</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>{done ? 'Back on shelf' : 'Restock requested'}</TableHead>
                <TableHead className="text-right">Refund</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ret.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="min-w-36 font-medium whitespace-normal">
                    {item.medicine.name}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="font-mono text-sm">{item.batch.batchNumber}</span>
                    <p className="text-xs text-muted-foreground">
                      Exp {formatDate(item.batch.expiryDate)}
                    </p>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatQuantity(item.quantity, item.medicine.unit)}
                  </TableCell>
                  <TableCell>
                    {item.restock ? 'Yes' : done ? 'No (damaged or expired)' : 'No (damaged)'}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMoney(item.refundAmount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-right">
                  Refund total
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(ret.refundTotal)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="return-refunds-heading">
        <h3 id="return-refunds-heading" className="text-lg font-semibold">
          {done ? 'Refunded by' : pending ? 'Refund by' : 'Refund requested by'}
        </h3>
        {ret.refunds.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">
            Nothing to refund: the sale was fully discounted.
          </p>
        ) : (
          <div className="max-w-lg rounded-lg border">
            <Table>
              <TableBody>
                {ret.refunds.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      {PAYMENT_LABELS[r.method]}
                      {r.reference && (
                        <p className="font-mono text-xs text-muted-foreground">{r.reference}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(r.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title={`Approve return ${ret.returnNumber}?`}
        description={`${restocked > 0 ? `${restocked} ${restocked === 1 ? 'unit goes' : 'units go'} back on the shelf (unless the batch has expired) and ` : ''}${formatMoney(ret.refundTotal)} is refunded to the customer now. This cannot be undone.`}
        confirmLabel="Approve and refund"
        pending={approve.isPending}
        onConfirm={() => approve.mutate()}
      >
        <ul className="space-y-1 text-sm">
          {ret.refunds.map((r) => (
            <li key={r.id} className="flex justify-between">
              <span>{PAYMENT_LABELS[r.method]}</span>
              <span className="tabular-nums">{formatMoney(r.amount)}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      {rejecting && <RejectReturnDialog ret={ret} onClose={() => setRejecting(false)} />}
    </div>
  );
}
