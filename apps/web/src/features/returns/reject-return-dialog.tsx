import { rejectReturnBodySchema, type RejectReturnBody, type ReturnDto } from '@pharmacy/shared';
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
import { invalidateAfterSaleChange } from '@/features/sales/sales-api';
import { errorMessage } from '@/lib/api';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { returnsApi } from './returns-api';

/** Turns down a cashier's return: nothing moves, and its units can be returned again. */
export function RejectReturnDialog({ ret, onClose }: { ret: ReturnDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const reject = useMutation({
    mutationFn: (body: RejectReturnBody) => returnsApi.reject(ret.id, body),
    meta: { skipErrorToast: true },
    onSuccess: async (rejected) => {
      toast.success(`Return ${rejected.returnNumber} rejected`);
      onClose();
      await invalidateAfterSaleChange(queryClient);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
      // Someone else may have approved or rejected it meanwhile.
      void invalidateAfterSaleChange(queryClient);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(rejectReturnBodySchema, { reason });
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    reject.mutate(parsed.data);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !reject.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject return {ret.returnNumber}?</DialogTitle>
          <DialogDescription>
            No stock moves and nothing is refunded. {ret.requestedBy.fullName} sees your reason, and
            the units can be returned again later.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field id="reject-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Pack has been opened; seal broken"
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
              Reject return
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
