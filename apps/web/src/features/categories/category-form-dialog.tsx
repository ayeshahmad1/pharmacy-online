import {
  createCategoryBodySchema,
  type CategoryDto,
  type CreateCategoryBody,
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
import { categoriesApi, invalidateAfterCatalogWrite } from '@/features/catalog/catalog-api';
import { errorMessage } from '@/lib/api';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';

/** Create (category = null) or edit a category. Mount with a `key` per record to reset it. */
export function CategoryFormDialog({
  open,
  onOpenChange,
  category,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: CategoryDto | null;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: category?.name ?? '',
    description: category?.description ?? '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: CreateCategoryBody) =>
      category ? categoriesApi.update(category.id, body) : categoriesApi.create(body),
    meta: { skipErrorToast: true },
    onSuccess: async (saved) => {
      toast.success(category ? `Saved ${saved.name}` : `Added category ${saved.name}`);
      onOpenChange(false);
      await invalidateAfterCatalogWrite(queryClient, 'category');
    },
    onError: (err) => {
      // A duplicate name comes back as a 409 on the name field.
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(err));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = parseForm(createCategoryBodySchema, values);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    save.mutate(parsed.data);
  }

  const set = (field: keyof typeof values) => (value: string) =>
    setValues((v) => ({ ...v, [field]: value }));

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>Categories group medicines in lists and reports.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && <FormAlert>{formError}</FormAlert>}
          <Field id="category-name" label="Name" error={errors.name} required>
            <Input
              value={values.name}
              onChange={(e) => set('name')(e.target.value)}
              placeholder="e.g. Analgesics"
              autoFocus
            />
          </Field>
          <Field id="category-description" label="Description" error={errors.description}>
            <Textarea
              value={values.description}
              onChange={(e) => set('description')(e.target.value)}
              rows={3}
            />
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
              {category ? 'Save changes' : 'Add category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
