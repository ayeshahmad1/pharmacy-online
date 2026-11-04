import {
  correctBatchExpiryBodySchema,
  type BatchStockDto,
  type CorrectBatchExpiryBody,
} from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, Loader2Icon } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api';
import { formatDate, formatQuantity } from '@/lib/format';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { inventoryApi, invalidateStock } from './inventory-api';

const QUICK_REASONS = [
  'Date on the pack',
  'Old system kept the previous lot date',
  'Entered wrongly at delivery',
];

/**
 * Fixes a wrongly entered expiry date. Stock is not touched; the API applies
 * the date to every batch of the same lot and records each in the audit log.
 */
export function CorrectExpiryDialog({
  batch,
  onClose,
}: {
  batch: BatchStockDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [expiryDate, setExpiryDate] = useState(batch.expiryDate);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const correct = useMutation({
    mutationFn: (body: CorrectBatchExpiryBody) => inventoryApi.correctExpiry(batch.id, body),
    meta: { skipErrorToast: true },
    onSuccess: async (result) => {
      const others = result.batches.length - 1;
      toast.success(
        `${batch.medicine.name} batch ${batch.batchNumber}: expiry ${formatDate(result.expiryBefore)} → ${formatDate(expiryDate)}${
          others > 0
            ? ` (and ${others} more ${others === 1 ? 'delivery' : 'deliveries'} of this lot)`
            : ''
        }`,
      );
      onClose();
      await invalidateStock(queryClient);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(correctBatchExpiryBodySchema, { expiryDate, reason });
    if (!parsed.ok) return setErrors(parsed.errors);
    if (parsed.data.expiryDate === batch.expiryDate) {
      return setErrors({ expiryDate: 'Pick a different date' });
    }
    setErrors({});
    correct.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !correct.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct expiry date</DialogTitle>
          <DialogDescription>
            {batch.medicine.name} · batch <span className="font-mono">{batch.batchNumber}</span> ·{' '}
            {formatQuantity(batch.quantity, batch.medicine.unit)} in stock
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <p className="text-sm text-muted-foreground">
            Only for a date that was entered wrongly: check it against the pack. Every delivery of
            this batch number gets the new date. A date that has passed makes the batch expired, and
            billing will stop selling it.
          </p>

          <Field id="correct-expiry-date" label="Expiry date" error={errors.expiryDate} required>
            <Input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              autoFocus
            />
          </Field>

          <div className="flex items-center justify-between rounded-md bg-muted px-4 py-3 text-sm">
            <span className="text-muted-foreground">Expiry</span>
            <span className="flex items-center gap-2 font-medium tabular-nums">
              {formatDate(batch.expiryDate)}
              <ArrowRightIcon className="size-4 text-muted-foreground" />
              {/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) ? formatDate(expiryDate) : '—'}
            </span>
          </div>

          <Field id="correct-expiry-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why was the date wrong?"
            />
          </Field>
          <div className="-mt-2 flex flex-wrap gap-2">
            {QUICK_REASONS.map((r) => (
              <Button
                key={r}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReason(r)}
              >
                {r}
              </Button>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={correct.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={correct.isPending}>
              {correct.isPending && <Loader2Icon className="animate-spin" />}
              Save expiry date
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
