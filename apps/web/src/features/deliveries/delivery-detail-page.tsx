import type { DeliveryDto } from '@pharmacy/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ClockIcon, PencilIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { BackLink, DetailError, DetailSkeleton, Facts } from '@/components/data/detail-states';
import { FormAlert } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { deliveriesApi, deliveriesKeys, invalidateAfterDelivery } from './deliveries-api';
import { DeliveryItemsTable } from './delivery-form';
import { DeliveryStatusBadge } from './delivery-status';
import { RejectDeliveryDialog } from './reject-delivery-dialog';

export function DeliveryDetailPage() {
  const { id = '' } = useParams();
  const delivery = useQuery({
    queryKey: deliveriesKeys.detail(id),
    queryFn: ({ signal }) => deliveriesApi.get(id, signal),
  });

  if (delivery.isPending) return <DetailSkeleton />;
  if (delivery.isError) {
    return (
      <DetailError
        error={delivery.error}
        onRetry={() => void delivery.refetch()}
        retrying={delivery.isFetching}
        missingTitle="Delivery not found"
        missingDescription="Cashiers can only open the deliveries they entered."
        backTo="/deliveries"
        backLabel="Back to deliveries"
      />
    );
  }
  return <DeliveryDetail delivery={delivery.data} />;
}

function DeliveryDetail({ delivery }: { delivery: DeliveryDto }) {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const pending = delivery.status === 'PENDING';
  const canEdit = pending && (isStaff || delivery.requestedBy.id === user.id);
  const newMedicines = new Set(
    delivery.items.flatMap((i) =>
      i.newMedicine && !i.medicine ? [i.newMedicine.name.toLowerCase()] : [],
    ),
  ).size;

  const approve = useMutation({
    mutationFn: () => deliveriesApi.approve(delivery.id),
    // The error stays on the page: it names the lines to correct.
    meta: { skipErrorToast: true },
    onSuccess: async (approved) => {
      toast.success(
        `Received ${approved.lineCount} ${approved.lineCount === 1 ? 'batch' : 'batches'} from ${approved.supplier.name}`,
      );
      setApproving(false);
      await invalidateAfterDelivery(queryClient);
    },
    onError: () => {
      setApproving(false);
      void invalidateAfterDelivery(queryClient);
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink to="/deliveries">Deliveries</BackLink>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold">{delivery.supplier.name}</h2>
              <DeliveryStatusBadge status={delivery.status} />
            </div>
            <p className="text-muted-foreground">
              {delivery.invoiceNumber ? `Invoice ${delivery.invoiceNumber}` : 'No invoice number'}
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {isStaff && (
                <Button onClick={() => setApproving(true)}>
                  <CheckIcon /> Approve
                </Button>
              )}
              <Button asChild variant="outline">
                <Link to={`/deliveries/${delivery.id}/edit`}>
                  <PencilIcon /> {isStaff ? 'Correct' : 'Edit'}
                </Link>
              </Button>
              {isStaff && (
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setRejecting(true)}
                >
                  <XIcon /> Reject
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {approve.isError && (
        <FormAlert>
          Not approved: {errorMessage(approve.error)}. Correct the delivery, then approve it again.
        </FormAlert>
      )}
      {pending && !isStaff && (
        <p className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <ClockIcon className="size-5 shrink-0" />
          Waiting for a pharmacist or admin to check it. The stock can be sold once it is approved.
        </p>
      )}
      {delivery.status === 'REJECTED' && (
        <div className="rounded-lg border p-4 text-sm">
          <p className="font-medium">
            Rejected
            {delivery.reviewedBy && ` by ${delivery.reviewedBy.fullName}`}
            {delivery.reviewedAt && `, ${formatDateTime(delivery.reviewedAt)}`}
          </p>
          {delivery.rejectionReason && <p className="mt-1">Reason: {delivery.rejectionReason}</p>}
          <p className="mt-1 text-muted-foreground">Nothing from it went into stock.</p>
        </div>
      )}

      <Facts
        items={[
          ['Total cost', <span className="tabular-nums">{formatMoney(delivery.totalCost)}</span>],
          ['Units', delivery.units.toLocaleString()],
          [
            'Entered',
            `${formatDateTime(delivery.requestedAt)} by ${delivery.requestedBy.fullName}`,
          ],
          [
            pending ? 'Review' : 'Reviewed',
            pending
              ? 'Awaiting approval'
              : delivery.reviewedBy
                ? `${delivery.reviewedAt ? formatDateTime(delivery.reviewedAt) : ''} by ${delivery.reviewedBy.fullName}`
                : '—',
          ],
          [
            'Corrected',
            delivery.correctedBy
              ? `${delivery.correctedAt ? formatDateTime(delivery.correctedAt) : ''} by ${delivery.correctedBy.fullName}`
              : 'No',
          ],
        ]}
      />

      <section className="space-y-3" aria-labelledby="delivery-items-heading">
        <h3 id="delivery-items-heading" className="text-lg font-semibold">
          Items
        </h3>
        <DeliveryItemsTable delivery={delivery} />
      </section>

      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title="Approve this delivery?"
        description={`${delivery.lineCount} ${delivery.lineCount === 1 ? 'batch' : 'batches'} (${delivery.units.toLocaleString()} units, ${formatMoney(delivery.totalCost)}) go into stock now and can be sold.${newMedicines > 0 ? ` ${newMedicines} new ${newMedicines === 1 ? 'medicine is' : 'medicines are'} added to the catalogue at the selling price shown.` : ''} This cannot be undone; a wrong count is fixed later with a stock adjustment.`}
        confirmLabel="Approve and receive"
        pending={approve.isPending}
        onConfirm={() => approve.mutate()}
      />
      {rejecting && (
        <RejectDeliveryDialog delivery={delivery} onClose={() => setRejecting(false)} />
      )}
    </div>
  );
}
