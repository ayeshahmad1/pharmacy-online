import {
  rejectDeliveryBodySchema,
  type DeliveryDto,
  type RejectDeliveryBody,
} from '@pharmacy/shared';
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
import { deliveriesApi, invalidateAfterDelivery } from './deliveries-api';

/** Turns down a cashier's delivery: nothing enters stock. */
export function RejectDeliveryDialog({
  delivery,
  onClose,
}: {
  delivery: DeliveryDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const reject = useMutation({
    mutationFn: (body: RejectDeliveryBody) => deliveriesApi.reject(delivery.id, body),
    meta: { skipErrorToast: true },
    onSuccess: async () => {
      toast.success(`Delivery from ${delivery.supplier.name} rejected`);
      onClose();
      await invalidateAfterDelivery(queryClient);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
      // Someone else may have approved or rejected it meanwhile.
      void invalidateAfterDelivery(queryClient);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(rejectDeliveryBodySchema, { reason });
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    reject.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !reject.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject this delivery?</DialogTitle>
          <DialogDescription>
            Nothing goes into stock. {delivery.requestedBy.fullName} sees your reason. If only a few
            lines are wrong, correct it and approve instead.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field id="reject-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Goods were sent back to the supplier"
              rows={3}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={reject.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={reject.isPending}>
              {reject.isPending && <Loader2Icon className="animate-spin" />}
              Reject delivery
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
