import {
  deliveryBodySchema,
  type DeliveryBody,
  type DeliveryDto,
  type SupplierDto,
} from '@pharmacy/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  CircleCheckIcon,
  ClockIcon,
  Loader2Icon,
  PackagePlusIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { BackLink, DetailError, DetailSkeleton } from '@/components/data/detail-states';
import { Field, FormAlert } from '@/components/form/field';
import { MoneyInput } from '@/components/form/money-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCurrentUser } from '@/features/auth/auth-context';
import { catalogKeys, medicinesApi, suppliersApi } from '@/features/catalog/catalog-api';
import { MedicinePicker, SupplierPicker } from '@/features/catalog/pickers';
import { useActiveCategories } from '@/features/catalog/use-categories';
import { COMMON_UNITS } from '@/features/medicines/medicine-form-dialog';
import { errorMessage } from '@/lib/api';
import { formatDate, formatQuantity } from '@/lib/format';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { deliveriesApi, deliveriesKeys, invalidateAfterDelivery } from './deliveries-api';
import {
  emptyLine,
  emptyNewMedicine,
  lineCost,
  lineDateErrors,
  lineUnit,
  lineWarnings,
  linesFromDelivery,
  receiptTotals,
  toReceiptInput,
  tomorrow,
  type NewMedicineDraft,
  type ReceiptLine,
} from './receipt-lines';

/**
 * Entering a supplier delivery: one line per batch. A cashier's waits for a
 * pharmacist or admin to approve it; staff's goes into stock at once. Either
 * way the API saves every line or none of them (rule 4).
 */
export function NewDeliveryPage() {
  const [search] = useSearchParams();
  const [saved, setSaved] = useState<DeliveryDto | null>(null);
  // Bumped to start a fresh form after a delivery is saved.
  const [formKey, setFormKey] = useState(0);

  if (saved) {
    return (
      <DeliveryDone
        delivery={saved}
        onAnother={() => {
          setSaved(null);
          setFormKey((k) => k + 1);
        }}
      />
    );
  }
  return (
    <DeliveryForm
      key={formKey}
      initialSupplierId={formKey === 0 ? search.get('supplierId') : null}
      initialMedicineId={formKey === 0 ? search.get('medicineId') : null}
      onSaved={setSaved}
    />
  );
}

/** Correcting a pending delivery: its cashier fixing a typo, or an approver before approving. */
export function EditDeliveryPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const delivery = useQuery({
    queryKey: deliveriesKeys.detail(id),
    queryFn: ({ signal }) => deliveriesApi.get(id, signal),
    // The form keeps its own copy; a refetch must not reset what is typed.
    staleTime: Infinity,
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
  if (delivery.data.status !== 'PENDING') {
    return (
      <div className="space-y-3">
        <BackLink to={`/deliveries/${id}`}>Delivery</BackLink>
        <p className="rounded-lg border p-4 text-sm">
          This delivery is already {delivery.data.status.toLowerCase()} and can no longer be
          changed.
        </p>
      </div>
    );
  }
  return (
    <DeliveryForm
      editing={delivery.data}
      initialSupplierId={delivery.data.supplier.id}
      initialMedicineId={null}
      onSaved={(saved) => void navigate(`/deliveries/${saved.id}`)}
    />
  );
}

function DeliveryForm({
  editing,
  initialSupplierId,
  initialMedicineId,
  onSaved,
}: {
  /** The pending delivery being corrected; absent for a new one. */
  editing?: DeliveryDto;
  initialSupplierId: string | null;
  initialMedicineId: string | null;
  onSaved: (delivery: DeliveryDto) => void;
}) {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState<SupplierDto | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState(editing?.invoiceNumber ?? '');
  const [lines, setLines] = useState<ReceiptLine[]>(() =>
    editing ? linesFromDelivery(editing) : [emptyLine()],
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // A newly added line's medicine field takes focus as soon as it mounts.
  const focusOnMount = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Links from a supplier or medicine row prefill the form, and so does the
  // delivery being corrected.
  const prefillSupplier = useQuery({
    queryKey: [...catalogKeys.suppliers, 'detail', initialSupplierId],
    queryFn: ({ signal }) => suppliersApi.get(initialSupplierId!, signal),
    enabled: !!initialSupplierId,
  });
  const prefillMedicine = useQuery({
    queryKey: [...catalogKeys.medicines, 'detail', initialMedicineId],
    queryFn: ({ signal }) => medicinesApi.get(initialMedicineId!, signal),
    enabled: !!initialMedicineId,
  });
  const [prefilled, setPrefilled] = useState({ supplier: false, medicine: false });
  if (!prefilled.supplier && prefillSupplier.data) {
    setPrefilled((p) => ({ ...p, supplier: true }));
    if (prefillSupplier.data.status === 'ACTIVE') setSupplier(prefillSupplier.data);
  }
  if (!prefilled.medicine && prefillMedicine.data) {
    setPrefilled((p) => ({ ...p, medicine: true }));
    if (prefillMedicine.data.status === 'ACTIVE') {
      const medicine = prefillMedicine.data;
      setLines((ls) => [{ ...ls[0]!, medicine }, ...ls.slice(1)]);
    }
  }

  const save = useMutation({
    mutationFn: (body: DeliveryBody) =>
      editing ? deliveriesApi.update(editing.id, body) : deliveriesApi.create(body),
    meta: { skipErrorToast: true },
    onSuccess: async (saved) => {
      toast.success(
        editing
          ? 'Delivery saved'
          : saved.status === 'APPROVED'
            ? `Received ${saved.lineCount} ${saved.lineCount === 1 ? 'batch' : 'batches'} from ${saved.supplier.name}`
            : 'Delivery sent for approval',
      );
      setDirty(false);
      onSaved(saved);
      await invalidateAfterDelivery(queryClient);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      setFormError(
        Object.keys(fields).length > 0
          ? `${errorMessage(err)}. Nothing was saved; fix the marked lines and try again.`
          : errorMessage(err),
      );
    },
  });

  // Leaving with a half-entered delivery loses it; ask first.
  const blocker = useBlocker(dirty && !save.isPending && !save.isSuccess);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  function updateLine(key: string, change: Partial<ReceiptLine>) {
    setDirty(true);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));
  }

  function addLine() {
    const line = emptyLine();
    focusOnMount.current = line.key;
    setLines((ls) => [...ls, line]);
  }

  function removeLine(key: string) {
    setDirty(true);
    setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((l) => l.key !== key)));
    // Line errors are keyed by position, which just shifted.
    setErrors((e) =>
      Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('items.'))),
    );
  }

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    setFormError(null);
    const parsed = parseForm(
      deliveryBodySchema,
      toReceiptInput(supplier?.id ?? '', invoiceNumber, lines),
    );
    const dateErrors = lineDateErrors(lines);
    if (!parsed.ok || Object.keys(dateErrors).length > 0) {
      setErrors({ ...(parsed.ok ? {} : parsed.errors), ...dateErrors });
      setFormError('Some fields need attention.');
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  // Enter in a field must not submit a long form by accident (a scanner
  // sends Enter after the barcode). Ctrl+Enter saves.
  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Enter') return;
    const target = event.target as HTMLElement;
    if (target.tagName !== 'INPUT') return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) handleSubmit();
  }

  const totals = receiptTotals(lines);
  const minExpiry = tomorrow();
  const batches = `${lines.length} ${lines.length === 1 ? 'batch' : 'batches'}`;
  const submitLabel = editing
    ? 'Save changes'
    : isStaff
      ? `Receive ${batches}`
      : `Send ${batches} for approval`;

  return (
    <form className="space-y-6" onSubmit={handleSubmit} onKeyDown={onFormKeyDown} noValidate>
      <div className="space-y-3">
        <BackLink to={editing ? `/deliveries/${editing.id}` : '/deliveries'}>
          {editing ? 'Delivery' : 'Deliveries'}
        </BackLink>
        <div>
          <h2 className="text-2xl font-semibold">
            {editing ? 'Correct delivery' : 'Receive stock'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {editing
              ? `Entered by ${editing.requestedBy.fullName}. Fix anything that does not match the invoice, then approve it.`
              : isStaff
                ? 'Enter one supplier delivery. Each line becomes a batch with its own expiry date and cost.'
                : 'Enter one supplier delivery as it is on the invoice. A pharmacist or admin checks it before the stock can be sold.'}
          </p>
        </div>
      </div>

      {formError && <FormAlert>{formError}</FormAlert>}

      <Card>
        <CardHeader>
          <CardTitle>Delivery</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="receive-supplier" label="Supplier" error={errors.supplierId} required>
            <SupplierPicker
              value={supplier}
              onChange={(s) => {
                setDirty(true);
                setSupplier(s);
              }}
            />
          </Field>
          <Field
            id="receive-invoice"
            label="Invoice / delivery note no."
            error={errors.invoiceNumber}
            hint="Kept on the stock history for tracing"
          >
            <Input
              value={invoiceNumber}
              onChange={(e) => {
                setDirty(true);
                setInvoiceNumber(e.target.value);
              }}
              autoComplete="off"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Items</CardTitle>
          <span className="text-sm text-muted-foreground">
            {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          {errors.items && <FormAlert>{errors.items}</FormAlert>}
          {lines.map((line, index) => (
            <LineEditor
              key={line.key}
              line={line}
              index={index}
              errors={errors}
              minExpiry={minExpiry}
              onChange={(change) => updateLine(line.key, change)}
              onRemove={() => removeLine(line.key)}
              medicineRef={(el) => {
                if (el && focusOnMount.current === line.key) {
                  focusOnMount.current = null;
                  el.focus();
                }
              }}
            />
          ))}
          <Button type="button" variant="outline" onClick={addLine} className="w-full sm:w-auto">
            <PlusIcon /> Add line
          </Button>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center lg:-mx-6 lg:px-6">
        <dl className="flex flex-1 gap-6 text-sm">
          <div>
            <dt className="text-muted-foreground">Units</dt>
            <dd className="text-lg font-semibold tabular-nums">{totals.units.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Total cost</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatMoney(totals.cost)}</dd>
          </div>
        </dl>
        <p className="hidden text-xs text-muted-foreground md:block">Ctrl+Enter to save</p>
        <Button type="submit" size="lg" disabled={save.isPending}>
          {save.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : editing ? (
            <SaveIcon />
          ) : (
            <PackagePlusIcon />
          )}
          {submitLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description={
          editing
            ? 'Your changes to this delivery have not been saved.'
            : 'This delivery has not been saved yet. What you typed will be lost.'
        }
        confirmLabel="Leave"
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </form>
  );
}

function LineEditor({
  line,
  index,
  errors,
  minExpiry,
  onChange,
  onRemove,
  medicineRef,
}: {
  line: ReceiptLine;
  index: number;
  errors: FieldErrors;
  minExpiry: string;
  onChange: (change: Partial<ReceiptLine>) => void;
  onRemove: () => void;
  medicineRef: (el: HTMLInputElement | null) => void;
}) {
  const id = (field: string) => `line-${line.key}-${field}`;
  const error = (field: string) => errors[`items.${index}.${field}`];
  const warnings = lineWarnings(line);
  const cost = lineCost(line);
  const unit = lineUnit(line);
  const hasError = Object.keys(errors).some((k) => k.startsWith(`items.${index}.`));
  const proposal = line.newMedicine;

  return (
    <fieldset
      className={cn('rounded-lg border p-3', hasError && 'border-destructive/50 bg-destructive/5')}
    >
      <legend className="sr-only">Line {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_minmax(8rem,1fr)_10rem_7rem_9rem_auto]">
        <div className="space-y-1">
          {proposal ? (
            <Field
              id={id('new-name')}
              label="New medicine name"
              error={error('newMedicine.name') ?? error('medicineId')}
              required
            >
              <Input
                ref={medicineRef}
                value={proposal.name}
                onChange={(e) => onChange({ newMedicine: { ...proposal, name: e.target.value } })}
                autoComplete="off"
              />
            </Field>
          ) : (
            <Field id={id('medicine')} label="Medicine" error={error('medicineId')} required>
              <MedicinePicker
                value={line.medicine}
                onChange={(medicine) => onChange({ medicine })}
                onAddNew={(name) =>
                  onChange({ medicine: null, newMedicine: emptyNewMedicine(name) })
                }
                inputRef={medicineRef}
              />
            </Field>
          )}
          <button
            type="button"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() =>
              proposal
                ? onChange({ newMedicine: null })
                : onChange({ medicine: null, newMedicine: emptyNewMedicine() })
            }
          >
            {proposal ? 'Pick from the catalogue instead' : 'Not in the list? Add a new medicine'}
          </button>
        </div>
        <Field id={id('batch')} label="Batch no." error={error('batchNumber')} required>
          <Input
            value={line.batchNumber}
            onChange={(e) => onChange({ batchNumber: e.target.value.toUpperCase() })}
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
          />
        </Field>
        <Field id={id('expiry')} label="Expiry date" error={error('expiryDate')} required>
          <Input
            type="date"
            value={line.expiryDate}
            min={minExpiry}
            onChange={(e) => onChange({ expiryDate: e.target.value })}
          />
        </Field>
        <Field
          id={id('qty')}
          label={unit ? `Qty (${unit})` : 'Quantity'}
          error={error('quantity')}
          required
        >
          <Input
            value={line.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            inputMode="numeric"
            autoComplete="off"
            className="text-right tabular-nums"
          />
        </Field>
        <Field id={id('cost')} label="Cost per unit" error={error('costPrice')} required>
          <MoneyInput
            value={line.costPrice}
            onChange={(e) => onChange({ costPrice: e.target.value })}
          />
        </Field>
        <div className="flex items-end justify-between gap-2 sm:col-span-2 lg:col-span-1 lg:flex-col lg:items-end">
          <div className="text-sm lg:text-right">
            <p className="text-xs text-muted-foreground">Line total</p>
            <p className="font-medium tabular-nums">{cost === null ? '—' : formatMoney(cost)}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove line ${index + 1}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon className="size-5" />
          </Button>
        </div>
      </div>
      {proposal && (
        <NewMedicineFields
          line={line}
          proposal={proposal}
          error={(field) => error(`newMedicine.${field}`)}
          onChange={(change) => onChange({ newMedicine: { ...proposal, ...change } })}
        />
      )}
      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1">
          {warnings.map((w) => (
            <li
              key={w}
              className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300"
            >
              <AlertTriangleIcon className="size-4 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** The rest of a medicine that is not in the catalogue yet; it is added when the delivery is approved. */
function NewMedicineFields({
  line,
  proposal,
  error,
  onChange,
}: {
  line: ReceiptLine;
  proposal: NewMedicineDraft;
  error: (field: string) => string | undefined;
  onChange: (change: Partial<NewMedicineDraft>) => void;
}) {
  const categories = useActiveCategories();
  const id = (field: string) => `line-${line.key}-new-${field}`;
  const text = (field: keyof NewMedicineDraft) => ({
    value: proposal[field],
    onChange: (e: { target: { value: string } }) => onChange({ [field]: e.target.value }),
  });

  return (
    <div className="mt-3 grid gap-3 rounded-md border border-dashed bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-6">
      <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-6">
        New medicine: it is added to the catalogue when the delivery is approved.
      </p>
      <Field id={id('generic')} label="Generic / salt" error={error('genericName')}>
        <Input {...text('genericName')} autoComplete="off" />
      </Field>
      <Field id={id('barcode')} label="Barcode" error={error('barcode')}>
        <Input {...text('barcode')} autoComplete="off" spellCheck={false} className="font-mono" />
      </Field>
      <Field id={id('category')} label="Category" error={error('categoryId')} required>
        <NativeSelect {...text('categoryId')} disabled={categories.isPending}>
          <option value="">{categories.isPending ? 'Loading…' : 'Choose a category'}</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id={id('unit')} label="Unit" error={error('unit')} required>
        <Input {...text('unit')} list={id('units')} autoComplete="off" />
      </Field>
      <datalist id={id('units')}>
        {COMMON_UNITS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      <Field id={id('price')} label="Selling price per unit" error={error('sellingPrice')} required>
        <MoneyInput {...text('sellingPrice')} />
      </Field>
      <Field id={id('reorder')} label="Reorder level" error={error('reorderLevel')}>
        <Input
          {...text('reorderLevel')}
          inputMode="numeric"
          autoComplete="off"
          placeholder="0"
          className="text-right tabular-nums"
        />
      </Field>
    </div>
  );
}

function DeliveryDone({ delivery, onAnother }: { delivery: DeliveryDto; onAnother: () => void }) {
  const received = delivery.status === 'APPROVED';
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          className={cn(
            'flex size-14 items-center justify-center rounded-full',
            received ? 'bg-emerald-100 dark:bg-emerald-950' : 'bg-amber-100 dark:bg-amber-950',
          )}
        >
          {received ? (
            <CircleCheckIcon className="size-8 text-emerald-700 dark:text-emerald-400" />
          ) : (
            <ClockIcon className="size-8 text-amber-700 dark:text-amber-400" />
          )}
        </div>
        <h2 className="text-2xl font-semibold">
          {received ? 'Stock received' : 'Sent for approval'}
        </h2>
        <p className="text-muted-foreground">
          {delivery.lineCount} {delivery.lineCount === 1 ? 'batch' : 'batches'} ·{' '}
          {delivery.units.toLocaleString()} units from {delivery.supplier.name}
          {delivery.invoiceNumber && ` · invoice ${delivery.invoiceNumber}`}
        </p>
        {!received && (
          <p className="text-sm text-muted-foreground">
            A pharmacist or admin checks it against the invoice. The stock can be sold once it is
            approved.
          </p>
        )}
      </div>
      <DeliveryItemsTable delivery={delivery} />
      <div className="flex flex-col justify-center gap-2 sm:flex-row">
        <Button onClick={onAnother} autoFocus>
          <PackagePlusIcon /> Enter another delivery
        </Button>
        <Button asChild variant="outline">
          <Link to={`/deliveries/${delivery.id}`}>View this delivery</Link>
        </Button>
      </div>
    </div>
  );
}

/** A delivery's lines; a medicine proposed on it is marked as new. */
export function DeliveryItemsTable({ delivery }: { delivery: DeliveryDto }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Medicine</TableHead>
            <TableHead>Batch</TableHead>
            <TableHead>Expiry</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead className="text-right">Cost per unit</TableHead>
            <TableHead className="text-right">Line total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {delivery.items.map((item) => {
            const proposal = item.newMedicine;
            const unit = item.medicine?.unit ?? proposal?.unit ?? '';
            return (
              <TableRow key={item.id}>
                <TableCell className="min-w-44 whitespace-normal">
                  <p className="font-medium">{item.medicine?.name ?? proposal?.name}</p>
                  {proposal && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-amber-700 dark:text-amber-400">
                        {item.medicine ? 'Added to the catalogue' : 'New medicine'}
                      </span>
                      {' · '}
                      {[
                        proposal.genericName,
                        proposal.category.name,
                        `${formatMoney(proposal.sellingPrice)}/${proposal.unit}`,
                        proposal.barcode && `barcode ${proposal.barcode}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{item.batchNumber}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(item.expiryDate)}</TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatQuantity(item.quantity, unit)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatMoney(item.costPrice)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatMoney(item.lineCost)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
