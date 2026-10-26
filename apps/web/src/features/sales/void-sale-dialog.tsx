import { voidSaleBodySchema, type SaleDto, type VoidSaleBody } from '@pharmacy/shared';
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
import { errorMessage } from '@/lib/api';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { formatMoney } from '@/lib/money';
import { invalidateAfterSaleChange, salesApi } from './sales-api';

/** Voids a whole sale: every unit goes back to its batch, and the sale is kept as VOIDED. */
export function VoidSaleDialog({ sale, onClose }: { sale: SaleDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const units = sale.items.reduce((sum, i) => sum + i.quantity, 0);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const voidSale = useMutation({
    mutationFn: (body: VoidSaleBody) => salesApi.void(sale.id, body),
    meta: { skipErrorToast: true },
    onSuccess: async (voided) => {
      toast.success(`Sale ${voided.receiptNumber} voided; its stock is back on the shelf`);
      onClose();
      await invalidateAfterSaleChange(queryClient);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
      // A return may have been raised meanwhile: show the page's real state.
      void invalidateAfterSaleChange(queryClient);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(voidSaleBodySchema, { reason });
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    voidSale.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !voidSale.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Void sale {sale.receiptNumber}?</DialogTitle>
          <DialogDescription>
            {units === 1
              ? 'The unit sold goes back to its batch'
              : `All ${units} units go back to the batches they came from`}
            , and the {formatMoney(sale.grandTotal)} taken is handed back. The sale stays on record
            as voided. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field id="void-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Wrong medicine scanned, customer left without paying"
              rows={3}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={voidSale.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={voidSale.isPending}>
              {voidSale.isPending && <Loader2Icon className="animate-spin" />}
              Void sale
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
