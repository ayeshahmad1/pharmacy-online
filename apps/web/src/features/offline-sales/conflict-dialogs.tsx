import { dismissOfflineConflictBodySchema, type OfflineSaleConflictDto } from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Field, FormAlert } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { invalidateStock } from '@/features/inventory/inventory-api';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { formatMoney } from '@/lib/money';
import { offlineApi, offlineKeys } from '@/offline/offline-api';

/** What to do about each kind of refusal, for the reviewer. */
export function conflictAdvice(conflict: OfflineSaleConflictDto): string {
  switch (conflict.error.code) {
    case 'INSUFFICIENT_STOCK':
      return 'The server had less stock than this counter thought. Count the shelf; if the units were there, receive or adjust the missing stock in Inventory, then save the sale.';
    case 'PRICE_CHANGED':
      return 'A price changed between the sale and the sync. Save it at today’s prices, or dismiss it and settle the difference by hand.';
    case 'FORBIDDEN':
      return 'The cashier gave more discount than they may. Saving it approves the discount.';
    default:
      return 'Fix what the message says (e.g. reactivate a medicine), then save the sale, or dismiss it with a reason.';
  }
}

/** Charged offline vs what the catalogue says now, from a PRICE_CHANGED answer. */
function priceChange(conflict: OfflineSaleConflictDto) {
  if (conflict.error.code !== 'PRICE_CHANGED') return null;
  const details = conflict.error.details as { total?: unknown; expectedTotal?: unknown } | null;
  return typeof details?.total === 'string' && typeof details.expectedTotal === 'string'
    ? { now: details.total, charged: details.expectedTotal }
    : null;
}

function useReviewDone(onClose: () => void) {
  const queryClient = useQueryClient();
  return async () => {
    onClose();
    await queryClient.invalidateQueries({ queryKey: offlineKeys.all });
  };
}

/** Saves a flagged sale for its cashier and counter time. */
export function RetryConflictDialog({
  conflict,
  onClose,
}: {
  conflict: OfflineSaleConflictDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const done = useReviewDone(onClose);
  const change = priceChange(conflict);
  const [acceptPrices, setAcceptPrices] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = useMutation({
    mutationFn: () => offlineApi.retry(conflict.id, { acceptCurrentPrices: acceptPrices }),
    meta: { skipErrorToast: true },
    onSuccess: async (saved) => {
      toast.success(`Sale saved as ${saved.sale?.receiptNumber ?? 'a new receipt'}`);
      void invalidateStock(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
      await done();
    },
    onError: (err) => {
      // The server kept the sale open with this reason; show the list's new state too.
      setError(errorMessage(err));
      void queryClient.invalidateQueries({ queryKey: offlineKeys.all });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !retry.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Save flagged sale</DialogTitle>
          <DialogDescription>
            Sold {formatDateTime(conflict.soldAt)} by {conflict.cashier.fullName} ·{' '}
            {formatMoney(conflict.expectedTotal)} charged
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="rounded-md bg-muted p-3">
            <span className="font-medium">Refused: </span>
            {conflict.error.message}
          </p>
          <p className="text-muted-foreground">{conflictAdvice(conflict)}</p>
          <p className="text-muted-foreground">
            It is saved for {conflict.cashier.fullName} at the time it was sold, with the receipt
            number of that day. Stock comes from batches earliest expiry first.
          </p>
          {conflict.error.code === 'PRICE_CHANGED' && (
            <label className="flex min-h-10 cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={acceptPrices}
                onChange={(e) => setAcceptPrices(e.target.checked)}
              />
              <span>
                Charge today’s prices
                {change &&
                  ` (${formatMoney(change.now)} instead of ${formatMoney(change.charged)})`}
              </span>
            </label>
          )}
          {error && <FormAlert>{error}</FormAlert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={retry.isPending}>
            Cancel
          </Button>
          <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending && <Loader2Icon className="animate-spin" />}
            Save sale
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Closes a flagged sale without saving it; the reason is kept. */
export function DismissConflictDialog({
  conflict,
  onClose,
}: {
  conflict: OfflineSaleConflictDto;
  onClose: () => void;
}) {
  const done = useReviewDone(onClose);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const dismiss = useMutation({
    mutationFn: (body: { reason: string }) => offlineApi.dismiss(conflict.id, body),
    meta: { skipErrorToast: true },
    onSuccess: async () => {
      toast.success('Flagged sale dismissed');
      await done();
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(dismissOfflineConflictBodySchema, { reason });
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    dismiss.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !dismiss.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss flagged sale</DialogTitle>
          <DialogDescription>
            The sale is not saved and no stock moves. The record and your reason are kept.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field id="dismiss-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Recorded by hand as a stock adjustment"
              rows={3}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={dismiss.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={dismiss.isPending}>
              {dismiss.isPending && <Loader2Icon className="animate-spin" />}
              Dismiss
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
