import { adjustStockBodySchema, type AdjustStockBody, type BatchStockDto } from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, Loader2Icon, MinusIcon, PlusIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Field, FormAlert } from '@/components/form/field';
import { ToneBadge } from '@/components/status-badges';
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
import { ApiError, errorMessage } from '@/lib/api';
import { formatDate, formatQuantity } from '@/lib/format';
import { intInput, parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { expiryStatus } from '@/lib/stock-status';
import { cn } from '@/lib/utils';
import { inventoryApi, invalidateStock } from './inventory-api';

const QUICK_REASONS = {
  remove: ['Damaged / broken', 'Stock count correction', 'Missing from shelf'],
  add: ['Stock count correction', 'Found in store room'],
};

/**
 * Corrects one batch's count after a physical check. The change is recorded
 * as an ADJUSTMENT movement with the reason; the batch's stock is never
 * overwritten (rule 5).
 */
export function AdjustStockDialog({
  batch,
  onClose,
}: {
  batch: BatchStockDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<'remove' | 'add'>('remove');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const amount = intInput(quantity);
  const change = typeof amount === 'number' ? (direction === 'add' ? amount : -amount) : null;
  const after = change === null ? null : batch.quantity + change;
  const unit = batch.medicine.unit;

  const adjust = useMutation({
    mutationFn: (body: AdjustStockBody) => inventoryApi.adjust(body),
    meta: { skipErrorToast: true },
    onSuccess: async (result) => {
      toast.success(
        `${batch.medicine.name} batch ${batch.batchNumber}: ${result.quantityBefore} → ${result.quantityAfter}`,
      );
      onClose();
      await invalidateStock(queryClient);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        fields.quantity = err.message;
        // Someone else sold or adjusted this batch meanwhile; show the new count.
        void invalidateStock(queryClient);
      }
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (typeof amount === 'number' && amount < 0) {
      return setErrors({ quantity: 'Enter how many units, without a sign' });
    }
    const parsed = parseForm(adjustStockBodySchema, {
      batchId: batch.id,
      quantity: change ?? amount,
      reason,
    });
    if (!parsed.ok) return setErrors(parsed.errors);
    if (after !== null && after < 0) {
      return setErrors({
        quantity: `Only ${formatQuantity(batch.quantity, unit)} in this batch; cannot remove more`,
      });
    }
    setErrors({});
    adjust.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !adjust.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>
            {batch.medicine.name} · batch <span className="font-mono">{batch.batchNumber}</span> ·
            expires {formatDate(batch.expiryDate)}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          {batch.isExpired && (
            <div className="flex items-center gap-2 text-sm">
              <ToneBadge status={expiryStatus(batch)} />
              Expired stock cannot be sold. To clear it, use the write-off on the Expired list.
            </div>
          )}

          <div role="radiogroup" aria-label="Adjustment" className="grid grid-cols-2 gap-2">
            {(['remove', 'add'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                onClick={() => setDirection(d)}
                className={cn(
                  'flex h-12 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
                  direction === d
                    ? d === 'remove'
                      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300'
                      : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                    : 'hover:bg-accent',
                )}
              >
                {d === 'remove' ? (
                  <MinusIcon className="size-4" />
                ) : (
                  <PlusIcon className="size-4" />
                )}
                {d === 'remove' ? 'Remove units' : 'Add units'}
              </button>
            ))}
          </div>

          <Field id="adjust-quantity" label={`Quantity (${unit})`} error={errors.quantity} required>
            <Input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              autoFocus
            />
          </Field>

          <div className="flex items-center justify-between rounded-md bg-muted px-4 py-3 text-sm">
            <span className="text-muted-foreground">Stock in batch</span>
            <span className="flex items-center gap-2 font-medium tabular-nums">
              {formatQuantity(batch.quantity, unit)}
              <ArrowRightIcon className="size-4 text-muted-foreground" />
              <span className={cn(after !== null && after < 0 && 'text-destructive')}>
                {after === null ? '—' : formatQuantity(after, unit)}
              </span>
            </span>
          </div>

          <Field id="adjust-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why is the count changing?"
            />
          </Field>
          <div className="-mt-2 flex flex-wrap gap-2">
            {QUICK_REASONS[direction].map((r) => (
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
            <Button type="button" variant="outline" onClick={onClose} disabled={adjust.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={direction === 'remove' ? 'destructive' : 'default'}
              disabled={adjust.isPending}
            >
              {adjust.isPending && <Loader2Icon className="animate-spin" />}
              {direction === 'remove' ? 'Remove from stock' : 'Add to stock'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
