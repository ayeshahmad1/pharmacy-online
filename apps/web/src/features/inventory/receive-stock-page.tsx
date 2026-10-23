import {
  receiveStockBodySchema,
  type BatchStockDto,
  type ReceiveStockBody,
  type SupplierDto,
} from '@pharmacy/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CircleCheckIcon,
  Loader2Icon,
  PackagePlusIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useBlocker, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Field, FormAlert } from '@/components/form/field';
import { MoneyInput } from '@/components/form/money-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { catalogKeys, medicinesApi, suppliersApi } from '@/features/catalog/catalog-api';
import { MedicinePicker, SupplierPicker } from '@/features/catalog/pickers';
import { errorMessage } from '@/lib/api';
import { formatDate, formatQuantity } from '@/lib/format';
import { parseForm, serverFieldErrors, type FieldErrors } from '@/lib/form';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { inventoryApi, invalidateStock } from './inventory-api';
import {
  emptyLine,
  lineCost,
  lineDateErrors,
  lineWarnings,
  receiptTotals,
  toReceiptInput,
  tomorrow,
  type ReceiptLine,
} from './receipt-lines';

type Received = { supplier: SupplierDto; invoiceNumber: string | null; batches: BatchStockDto[] };

/**
 * Purchase entry: one supplier delivery with one line per batch. The API
 * saves every line or none of them (rule 4), each as a new batch with a
 * PURCHASE movement.
 */
export function ReceiveStockPage() {
  const [search] = useSearchParams();
  const [received, setReceived] = useState<Received | null>(null);
  // Bumped to start a fresh form after a delivery is saved.
  const [formKey, setFormKey] = useState(0);

  if (received) {
    return (
      <ReceiptDone
        received={received}
        onAnother={() => {
          setReceived(null);
          setFormKey((k) => k + 1);
        }}
      />
    );
  }
  return (
    <ReceiveStockForm
      key={formKey}
      initialSupplierId={formKey === 0 ? search.get('supplierId') : null}
      initialMedicineId={formKey === 0 ? search.get('medicineId') : null}
      onReceived={setReceived}
    />
  );
}

function ReceiveStockForm({
  initialSupplierId,
  initialMedicineId,
  onReceived,
}: {
  initialSupplierId: string | null;
  initialMedicineId: string | null;
  onReceived: (received: Received) => void;
}) {
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState<SupplierDto | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [lines, setLines] = useState<ReceiptLine[]>(() => [emptyLine()]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // A newly added line's medicine field takes focus as soon as it mounts.
  const focusOnMount = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Links from a supplier or medicine row prefill the form.
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

  const receive = useMutation({
    mutationFn: (body: ReceiveStockBody) => inventoryApi.receive(body),
    meta: { skipErrorToast: true },
    onSuccess: async (batches, body) => {
      toast.success(
        `Received ${batches.length} ${batches.length === 1 ? 'batch' : 'batches'} from ${supplier!.name}`,
      );
      setDirty(false);
      onReceived({ supplier: supplier!, invoiceNumber: body.invoiceNumber ?? null, batches });
      await invalidateStock(queryClient);
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
  const blocker = useBlocker(dirty && !receive.isPending && !receive.isSuccess);
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
      receiveStockBodySchema,
      toReceiptInput(supplier?.id ?? '', invoiceNumber, lines),
    );
    const dateErrors = lineDateErrors(lines);
    if (!parsed.ok || Object.keys(dateErrors).length > 0) {
      setErrors({ ...(parsed.ok ? {} : parsed.errors), ...dateErrors });
      setFormError('Some fields need attention.');
      return;
    }
    setErrors({});
    receive.mutate(parsed.data);
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

  return (
    <form className="space-y-6" onSubmit={handleSubmit} onKeyDown={onFormKeyDown} noValidate>
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to="/inventory">
            <ArrowLeftIcon /> Inventory
          </Link>
        </Button>
        <div>
          <h2 className="text-2xl font-semibold">Receive stock</h2>
          <p className="text-sm text-muted-foreground">
            Enter one supplier delivery. Each line becomes a batch with its own expiry date and
            cost.
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
        <Button type="submit" size="lg" disabled={receive.isPending}>
          {receive.isPending ? <Loader2Icon className="animate-spin" /> : <PackagePlusIcon />}
          Receive {lines.length} {lines.length === 1 ? 'batch' : 'batches'}
        </Button>
      </div>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title="Leave without saving?"
        description="This delivery has not been received yet. What you typed will be lost."
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
  const hasError = Object.keys(errors).some((k) => k.startsWith(`items.${index}.`));

  return (
    <fieldset
      className={cn('rounded-lg border p-3', hasError && 'border-destructive/50 bg-destructive/5')}
    >
      <legend className="sr-only">Line {index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,2fr)_minmax(8rem,1fr)_10rem_7rem_9rem_auto]">
        <Field id={id('medicine')} label="Medicine" error={error('medicineId')} required>
          <MedicinePicker
            value={line.medicine}
            onChange={(medicine) => onChange({ medicine })}
            inputRef={medicineRef}
          />
        </Field>
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
          label={line.medicine ? `Qty (${line.medicine.unit})` : 'Quantity'}
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

function ReceiptDone({ received, onAnother }: { received: Received; onAnother: () => void }) {
  const totalUnits = received.batches.reduce((n, b) => n + b.quantityReceived, 0);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
          <CircleCheckIcon className="size-8 text-emerald-700 dark:text-emerald-400" />
        </div>
        <h2 className="text-2xl font-semibold">Stock received</h2>
        <p className="text-muted-foreground">
          {received.batches.length} {received.batches.length === 1 ? 'batch' : 'batches'} ·{' '}
          {totalUnits.toLocaleString()} units from {received.supplier.name}
          {received.invoiceNumber && ` · invoice ${received.invoiceNumber}`}
        </p>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Medicine</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {received.batches.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <Link to={`/medicines/${b.medicine.id}`} className="font-medium hover:underline">
                    {b.medicine.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{b.batchNumber}</TableCell>
                <TableCell>{formatDate(b.expiryDate)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQuantity(b.quantityReceived, b.medicine.unit)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col justify-center gap-2 sm:flex-row">
        <Button onClick={onAnother} autoFocus>
          <PackagePlusIcon /> Receive another delivery
        </Button>
        <Button asChild variant="outline">
          <Link to="/inventory">View stock</Link>
        </Button>
      </div>
    </div>
  );
}
