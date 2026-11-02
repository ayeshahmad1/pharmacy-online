import {
  createMedicineBodySchema,
  type CreateMedicineBody,
  type MedicineDto,
} from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Field, FormAlert } from '@/components/form/field';
import { MoneyInput } from '@/components/form/money-input';
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
import { NativeSelect } from '@/components/ui/native-select';
import { invalidateAfterCatalogWrite, medicinesApi } from '@/features/catalog/catalog-api';
import { useActiveCategories } from '@/features/catalog/use-categories';
import { errorMessage } from '@/lib/api';
import { intInput, parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';

export const COMMON_UNITS = [
  'tablet',
  'capsule',
  'strip',
  'bottle',
  'tube',
  'sachet',
  'vial',
  'ampoule',
  'inhaler',
  'pack',
];

type Values = Record<
  'name' | 'genericName' | 'barcode' | 'categoryId' | 'unit' | 'reorderLevel' | 'sellingPrice',
  string
>;

/** Create (medicine = null) or edit a medicine. Mount with a `key` per record to reset it. */
export function MedicineFormDialog({
  open,
  onOpenChange,
  medicine,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicine: MedicineDto | null;
  onSaved?: (medicine: MedicineDto) => void;
}) {
  const queryClient = useQueryClient();
  const categories = useActiveCategories();
  const [values, setValues] = useState<Values>({
    name: medicine?.name ?? '',
    genericName: medicine?.genericName ?? '',
    barcode: medicine?.barcode ?? '',
    categoryId: medicine?.category.id ?? '',
    unit: medicine?.unit ?? 'tablet',
    reorderLevel: medicine ? String(medicine.reorderLevel) : '',
    sellingPrice: medicine?.sellingPrice ?? '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  // An existing medicine may sit in a category that has since been
  // deactivated; keep it selectable so editing other fields still works.
  const categoryOptions = (categories.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    inactive: false,
  }));
  if (medicine && !categoryOptions.some((c) => c.id === medicine.category.id)) {
    categoryOptions.unshift({ ...medicine.category, inactive: true });
  }

  const save = useMutation({
    mutationFn: (body: CreateMedicineBody) =>
      medicine ? medicinesApi.update(medicine.id, body) : medicinesApi.create(body),
    meta: { skipErrorToast: true },
    onSuccess: async (saved) => {
      toast.success(medicine ? `Saved ${saved.name}` : `Added ${saved.name}`);
      onOpenChange(false);
      onSaved?.(saved);
      await invalidateAfterCatalogWrite(queryClient, 'medicine');
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
    const parsed = parseForm(createMedicineBodySchema, {
      ...values,
      reorderLevel: intInput(values.reorderLevel),
    });
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    save.mutate(parsed.data);
  }

  const input = (field: keyof Values) => ({
    value: values[field],
    onChange: (e: { target: { value: string } }) =>
      setValues((v) => ({ ...v, [field]: e.target.value })),
  });

  const noCategories = categories.isSuccess && categoryOptions.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{medicine ? `Edit ${medicine.name}` : 'New medicine'}</DialogTitle>
          <DialogDescription>
            The selling price is what billing charges per unit. Stock is added by receiving batches,
            never typed in here.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          {noCategories && (
            <FormAlert>
              There are no active categories yet.{' '}
              <Link to="/categories" className="font-medium underline">
                Add a category
              </Link>{' '}
              first.
            </FormAlert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="medicine-name" label="Brand name" error={errors.name} required>
              <Input {...input('name')} placeholder="e.g. Panadol 500mg" autoFocus />
            </Field>
            <Field
              id="medicine-generic"
              label="Generic / salt"
              error={errors.genericName}
              hint="Used to suggest substitutes at the counter"
            >
              <Input {...input('genericName')} placeholder="e.g. Paracetamol" />
            </Field>
            <Field id="medicine-category" label="Category" error={errors.categoryId} required>
              <NativeSelect {...input('categoryId')} disabled={categories.isPending}>
                <option value="">
                  {categories.isPending ? 'Loading categories…' : 'Choose a category'}
                </option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.inactive ? ' (inactive)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              id="medicine-barcode"
              label="Barcode"
              error={errors.barcode}
              hint="Scan the pack, or leave blank"
            >
              <Input
                {...input('barcode')}
                autoComplete="off"
                spellCheck={false}
                // A scanner ends with Enter; do not let it submit the form half-filled.
                onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
              />
            </Field>
            <Field
              id="medicine-unit"
              label="Unit"
              error={errors.unit}
              required
              hint="What one unit of stock is"
            >
              <Input {...input('unit')} list="medicine-units" autoComplete="off" />
            </Field>
            <datalist id="medicine-units">
              {COMMON_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
            <Field
              id="medicine-price"
              label="Selling price per unit"
              error={errors.sellingPrice}
              required
            >
              <MoneyInput {...input('sellingPrice')} />
            </Field>
            <Field
              id="medicine-reorder"
              label="Reorder level"
              error={errors.reorderLevel}
              hint="Flagged as low stock at or below this many units"
            >
              <Input {...input('reorderLevel')} inputMode="numeric" placeholder="0" />
            </Field>
          </div>
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
              {medicine ? 'Save changes' : 'Add medicine'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
