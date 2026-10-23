import {
  createSupplierBodySchema,
  type CreateSupplierBody,
  type SupplierDto,
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { invalidateAfterCatalogWrite, suppliersApi } from '@/features/catalog/catalog-api';
import { errorMessage } from '@/lib/api';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';

type Values = Record<'name' | 'contactPerson' | 'phone' | 'email' | 'address', string>;

/** Create (supplier = null) or edit a supplier. Mount with a `key` per record to reset it. */
export function SupplierFormDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier: SupplierDto | null;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>({
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: CreateSupplierBody) =>
      supplier ? suppliersApi.update(supplier.id, body) : suppliersApi.create(body),
    meta: { skipErrorToast: true },
    onSuccess: async (saved) => {
      toast.success(supplier ? `Saved ${saved.name}` : `Added supplier ${saved.name}`);
      onOpenChange(false);
      await invalidateAfterCatalogWrite(queryClient, 'supplier');
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
    const parsed = parseForm(createSupplierBodySchema, values);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    save.mutate(parsed.data);
  }

  const input = (field: keyof Values) => ({
    value: values[field],
    onChange: (e: { target: { value: string } }) =>
      setValues((v) => ({ ...v, [field]: e.target.value })),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{supplier ? 'Edit supplier' : 'New supplier'}</DialogTitle>
          <DialogDescription>Distributors and companies that deliver stock.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field id="supplier-name" label="Name" error={errors.name} required>
            <Input {...input('name')} placeholder="e.g. Ali Medical Distributors" autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="supplier-contact" label="Contact person" error={errors.contactPerson}>
              <Input {...input('contactPerson')} autoComplete="off" />
            </Field>
            <Field id="supplier-phone" label="Phone" error={errors.phone}>
              <Input {...input('phone')} type="tel" inputMode="tel" placeholder="0300 1234567" />
            </Field>
          </div>
          <Field id="supplier-email" label="Email" error={errors.email}>
            <Input {...input('email')} type="email" autoComplete="off" />
          </Field>
          <Field id="supplier-address" label="Address" error={errors.address}>
            <Textarea {...input('address')} rows={2} />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2Icon className="animate-spin" />}
              {supplier ? 'Save changes' : 'Add supplier'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
