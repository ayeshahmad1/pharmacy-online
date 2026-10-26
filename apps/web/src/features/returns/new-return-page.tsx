import {
  createReturnBodySchema,
  type CreateReturnBody,
  type PaymentMethod,
  type ReturnableLineDto,
  type ReturnableSaleDto,
} from '@pharmacy/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon, SearchIcon, Undo2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { BackLink, Facts } from '@/components/data/detail-states';
import { ErrorState, TableSkeleton } from '@/components/data/list-states';
import { Field, FieldError, FormAlert } from '@/components/form/field';
import { MoneyInput } from '@/components/form/money-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useCurrentUser } from '@/features/auth/auth-context';
import { PAYMENT_LABELS } from '@/features/billing/payments';
import { invalidateAfterSaleChange } from '@/features/sales/sales-api';
import { SaleStatusBadge } from '@/features/sales/status-badges';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { parseForm, type FieldErrors } from '@/lib/form';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import {
  batchExpired,
  checkSplit,
  defaultSplit,
  emptyDrafts,
  planReturn,
  returnErrorFields,
  splitDrafts,
  type LineDrafts,
  type RefundDraft,
} from './return-lines';
import { returnsApi, returnsKeys } from './returns-api';

/**
 * Records a return against one sale: find the sale by its receipt number (or
 * arrive from the sale's page with ?saleId=), pick lines and quantities, and
 * see the refund the server will make.
 */
export function NewReturnPage() {
  const [search, setSearch] = useSearchParams();
  const saleId = search.get('saleId') ?? '';
  const receipt = (search.get('receipt') ?? '').trim().toUpperCase();
  const query = saleId ? { saleId } : receipt ? { receiptNumber: receipt } : null;

  const returnable = useQuery({
    queryKey: returnsKeys.returnable(query ?? {}),
    queryFn: ({ signal }) => returnsApi.returnable(query!, signal),
    enabled: query !== null,
  });

  const notFound =
    returnable.isError &&
    returnable.error instanceof ApiError &&
    (returnable.error.status === 404 || returnable.error.code === 'VALIDATION_ERROR');

  return (
    <div className="space-y-6">
      <BackLink to="/returns">Returns</BackLink>
      <ReceiptLookup
        key={`lookup-${receipt || saleId}`}
        initial={returnable.data?.sale.receiptNumber ?? receipt}
        error={notFound ? `No sale with receipt number ${receipt || 'in this link'}` : undefined}
        searching={returnable.isFetching && !returnable.data}
        onLookup={(value) => setSearch({ receipt: value })}
        autoFocus={query === null || notFound}
      />
      {query === null ? null : returnable.isPending ? (
        <TableSkeleton rows={3} />
      ) : returnable.isError ? (
        notFound ? null : (
          <ErrorState
            error={returnable.error}
            onRetry={() => void returnable.refetch()}
            retrying={returnable.isFetching}
          />
        )
      ) : (
        <ReturnForm key={returnable.data.sale.id} data={returnable.data} />
      )}
    </div>
  );
}

function ReceiptLookup({
  initial,
  error,
  searching,
  onLookup,
  autoFocus,
}: {
  initial: string;
  error?: string;
  searching: boolean;
  onLookup: (receipt: string) => void;
  autoFocus: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [empty, setEmpty] = useState(false);
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        const receipt = value.trim().toUpperCase();
        setEmpty(receipt === '');
        if (receipt) onLookup(receipt);
      }}
      noValidate
    >
      <Field
        id="return-receipt"
        label="Receipt number"
        error={empty ? 'Enter the receipt number from the slip' : error}
        hint="Type or scan it from the customer's receipt, e.g. S-20261026-0001"
        className="sm:w-80"
      >
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="S-YYYYMMDD-NNNN"
          autoComplete="off"
          spellCheck={false}
          className="font-mono uppercase"
          autoFocus={autoFocus}
        />
      </Field>
      <Button type="submit" variant="outline" className="sm:mt-[1.375rem]" disabled={searching}>
        {searching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
        Find sale
      </Button>
    </form>
  );
}

function ReturnForm({ data }: { data: ReturnableSaleDto }) {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { sale, lines, refundable } = data;

  const [drafts, setDrafts] = useState<LineDrafts>(() => emptyDrafts(lines));
  const [reason, setReason] = useState('');
  const [customSplit, setCustomSplit] = useState(false);
  const [refundDrafts, setRefundDrafts] = useState<RefundDraft[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CreateReturnBody | null>(null);

  const plan = planReturn(lines, drafts);
  const split = checkSplit(plan.total, refundable, refundDrafts);
  const autoSplit = defaultSplit(plan.total, refundable);
  const choosable = refundable.filter((r) => r.available !== '0.00').length > 1;
  // A sale the cashier of this screen may open (the API hides others' sales from cashiers).
  const canOpenSale = isStaff || sale.cashier.id === user.id;

  const create = useMutation({
    mutationFn: (body: CreateReturnBody) => returnsApi.create(body),
    meta: { skipErrorToast: true },
    onSuccess: async (ret) => {
      toast.success(
        ret.status === 'PENDING'
          ? `Return ${ret.returnNumber} sent for approval`
          : `Return ${ret.returnNumber} completed: refund ${formatMoney(ret.refundTotal)}`,
      );
      await invalidateAfterSaleChange(queryClient);
      void navigate(`/returns/${ret.id}`, { replace: true });
    },
    onError: (err, body) => {
      setConfirming(null);
      const fields = returnErrorFields(err, body);
      setErrors(fields);
      setFormError(Object.keys(fields).length === 0 ? errorMessage(err) : null);
      // Another return may have taken units or refund meanwhile: show what is left now.
      void queryClient.invalidateQueries({ queryKey: returnsKeys.all });
    },
  });

  function setLine(id: string, change: Partial<LineDrafts[string]>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...change } }));
    setErrors((e) =>
      Object.fromEntries(
        Object.entries(e).filter(([key]) => key !== `line.${id}` && key !== 'items'),
      ),
    );
  }

  function toggleSplit(on: boolean) {
    setCustomSplit(on);
    if (on) setRefundDrafts(splitDrafts(plan.total, refundable));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const body = {
      saleId: sale.id,
      items: plan.items,
      reason,
      ...(customSplit && { refunds: split.refunds }),
    };
    const parsed = parseForm(createReturnBodySchema, body);
    const found: FieldErrors = { ...plan.errors, ...(parsed.ok ? {} : parsed.errors) };
    if (customSplit && plan.items.length > 0) {
      for (const [method, message] of Object.entries(split.fieldErrors)) {
        found[`refund.${method}`] = message;
      }
      if (split.error) found.refunds = split.error;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.ok) return;
    setConfirming(parsed.data);
  }

  if (!data.canReturn) {
    const pending = lines.reduce((sum, l) => sum + l.pendingQuantity, 0);
    return (
      <div className="space-y-4">
        <SaleSummary data={data} canOpenSale={canOpenSale} />
        <FormAlert>
          {sale.status === 'VOIDED'
            ? `Sale ${sale.receiptNumber} was voided; nothing can be returned against it.`
            : pending > 0
              ? `Everything left on sale ${sale.receiptNumber} is already on a return waiting for approval.`
              : `Everything on sale ${sale.receiptNumber} has already been returned.`}
        </FormAlert>
      </div>
    );
  }

  return (
    <>
      <form className="space-y-6" onSubmit={submit} noValidate>
        <SaleSummary data={data} canOpenSale={canOpenSale} />
        {formError && <FormAlert>{formError}</FormAlert>}

        <section className="space-y-3" aria-labelledby="return-lines-heading">
          <h3 id="return-lines-heading" className="text-lg font-semibold">
            What is coming back
          </h3>
          <p className="text-sm text-muted-foreground">
            Enter how many units of each batch the customer is returning. Untick “Back on shelf” for
            damaged or opened packs: they are refunded but not restocked. Expired batches are never
            restocked.
          </p>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Medicine</TableHead>
                  <TableHead className="hidden sm:table-cell">Batch</TableHead>
                  <TableHead>Can return</TableHead>
                  <TableHead className="w-36">Returning</TableHead>
                  <TableHead>Back on shelf</TableHead>
                  <TableHead className="text-right">Refund</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, index) => (
                  <LineRow
                    key={line.id}
                    line={line}
                    index={index}
                    draft={drafts[line.id]!}
                    refund={plan.refunds[line.id]}
                    error={errors[`line.${line.id}`] ?? plan.errors[`line.${line.id}`]}
                    onChange={(change) => setLine(line.id, change)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          {errors.items && <FieldError>{errors.items}</FieldError>}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Field id="return-reason" label="Reason" error={errors.reason} required>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Doctor changed the prescription; pack unopened"
              rows={4}
            />
          </Field>

          <section
            className="space-y-3 rounded-lg border bg-muted/30 p-4"
            aria-labelledby="refund-heading"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 id="refund-heading" className="font-semibold">
                Refund
              </h3>
              <p className="text-2xl font-semibold tabular-nums" aria-live="polite">
                {formatMoney(plan.total)}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {plan.units === 0
                ? 'Enter quantities to see the refund.'
                : `${plan.units} ${plan.units === 1 ? 'unit' : 'units'}, refunded at what the customer paid after discounts.`}
            </p>

            {!customSplit ? (
              plan.total > 0n && (
                <p className="text-sm">
                  Paid back by{' '}
                  {autoSplit
                    .map(
                      (s) => `${PAYMENT_LABELS[s.method].toLowerCase()} ${formatMoney(s.amount)}`,
                    )
                    .join(', then ')}
                  .
                </p>
              )
            ) : (
              <RefundSplit
                drafts={refundDrafts}
                refundable={refundable}
                errors={errors}
                entered={split.entered}
                due={plan.total}
                onChange={(next) => {
                  setRefundDrafts(next);
                  setErrors((e) => {
                    const kept = Object.entries(e).filter(
                      ([key]) => key !== 'refunds' && !key.startsWith('refund.'),
                    );
                    return Object.fromEntries(kept);
                  });
                }}
                onReset={() => setRefundDrafts(splitDrafts(plan.total, refundable))}
              />
            )}
            {choosable && (
              <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-5 accent-primary"
                  checked={customSplit}
                  onChange={(e) => toggleSplit(e.target.checked)}
                />
                Choose how the refund is paid back
              </label>
            )}
            {!customSplit && errors.refunds && <FieldError>{errors.refunds}</FieldError>}
          </section>
        </div>

        {!isStaff && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Your return waits for a pharmacist or admin to approve it. Stock goes back and the
            refund is due once it is approved.
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button asChild variant="outline" size="lg">
            <Link to="/returns">Cancel</Link>
          </Button>
          <Button type="submit" size="lg" disabled={create.isPending}>
            {create.isPending ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
            {isStaff ? 'Complete return' : 'Send for approval'}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={isStaff ? 'Complete this return?' : 'Send this return for approval?'}
        description={
          isStaff
            ? `${plan.units} ${plan.units === 1 ? 'unit' : 'units'} come back against ${sale.receiptNumber} and ${formatMoney(plan.total)} is refunded now. This cannot be undone.`
            : `${plan.units} ${plan.units === 1 ? 'unit' : 'units'} against ${sale.receiptNumber}, refund ${formatMoney(plan.total)}, once a pharmacist or admin approves it.`
        }
        confirmLabel={isStaff ? 'Complete return' : 'Send for approval'}
        pending={create.isPending}
        onConfirm={() => confirming && create.mutate(confirming)}
      >
        <ul className="space-y-1 text-sm">
          {(customSplit
            ? split.refunds.map((r) => ({ method: r.method, amount: r.amount }))
            : autoSplit
          ).map((r) => (
            <li key={r.method} className="flex justify-between">
              <span>{PAYMENT_LABELS[r.method]}</span>
              <span className="tabular-nums">{formatMoney(r.amount)}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

function SaleSummary({ data, canOpenSale }: { data: ReturnableSaleDto; canOpenSale: boolean }) {
  const { sale, refundable } = data;
  return (
    <section className="space-y-3" aria-labelledby="return-sale-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="return-sale-heading" className="text-xl font-semibold">
          Sale{' '}
          {canOpenSale ? (
            <Link to={`/sales/${sale.id}`} className="font-mono hover:underline">
              {sale.receiptNumber}
            </Link>
          ) : (
            <span className="font-mono">{sale.receiptNumber}</span>
          )}
        </h2>
        <SaleStatusBadge status={sale.status} />
      </div>
      <Facts
        items={[
          ['Sold', formatDateTime(sale.soldAt)],
          ['Cashier', sale.cashier.fullName],
          ['Total', <span className="tabular-nums">{formatMoney(sale.grandTotal)}</span>],
          [
            'Paid by',
            refundable.map((r) => PAYMENT_LABELS[r.method]).join(', ') || 'Nothing (discounted)',
          ],
          [
            'Still refundable',
            <span className="tabular-nums">
              {refundable.length === 0 || !data.canReturn
                ? '—'
                : refundable
                    .map((r) => `${PAYMENT_LABELS[r.method]} ${formatMoney(r.available)}`)
                    .join(' · ')}
            </span>,
          ],
        ]}
      />
    </section>
  );
}

function LineRow({
  line,
  index,
  draft,
  refund,
  error,
  onChange,
}: {
  line: ReturnableLineDto;
  index: number;
  draft: LineDrafts[string];
  refund: bigint | undefined;
  error: string | undefined;
  onChange: (change: Partial<LineDrafts[string]>) => void;
}) {
  const expired = batchExpired(line);
  const none = line.returnableQuantity === 0;
  const qtyId = `return-qty-${index}`;
  return (
    <TableRow className={cn('align-top', none && 'text-muted-foreground')}>
      <TableCell className="min-w-36 whitespace-normal">
        <span className="font-medium">{line.medicine.name}</span>
        <p className="text-xs text-muted-foreground sm:hidden">
          Batch {line.batch.batchNumber} · Exp {formatDate(line.batch.expiryDate)}
        </p>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap sm:table-cell">
        <span className="font-mono text-sm">{line.batch.batchNumber}</span>
        <p className={cn('text-xs', expired ? 'text-destructive' : 'text-muted-foreground')}>
          {expired ? 'Expired' : 'Exp'} {formatDate(line.batch.expiryDate)}
        </p>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="tabular-nums">
          {line.returnableQuantity} of {line.quantity}
        </span>
        {(line.returnedQuantity > 0 || line.pendingQuantity > 0) && (
          <p className="text-xs text-muted-foreground">
            {[
              line.returnedQuantity > 0 && `${line.returnedQuantity} returned`,
              line.pendingQuantity > 0 && `${line.pendingQuantity} awaiting approval`,
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Input
            id={qtyId}
            value={draft.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            inputMode="numeric"
            autoComplete="off"
            placeholder="0"
            disabled={none}
            aria-label={`Units of ${line.medicine.name} batch ${line.batch.batchNumber} to return`}
            aria-invalid={!!error}
            aria-describedby={error ? `${qtyId}-error` : undefined}
            className="w-16 text-right tabular-nums"
            autoFocus={index === 0}
          />
          {!none && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ quantity: String(line.returnableQuantity) })}
            >
              All
            </Button>
          )}
        </div>
        {error && <FieldError id={`${qtyId}-error`}>{error}</FieldError>}
      </TableCell>
      <TableCell>
        {expired ? (
          <span className="text-xs text-muted-foreground">No: expired</span>
        ) : (
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-primary"
              checked={draft.restock}
              disabled={none}
              onChange={(e) => onChange({ restock: e.target.checked })}
            />
            <span className="sr-only sm:not-sr-only">{draft.restock ? 'Yes' : 'Damaged'}</span>
          </label>
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {refund === undefined ? '—' : formatMoney(refund)}
      </TableCell>
    </TableRow>
  );
}

function RefundSplit({
  drafts,
  refundable,
  errors,
  entered,
  due,
  onChange,
  onReset,
}: {
  drafts: RefundDraft[];
  refundable: ReturnableSaleDto['refundable'];
  errors: FieldErrors;
  entered: bigint;
  due: bigint;
  onChange: (drafts: RefundDraft[]) => void;
  onReset: () => void;
}) {
  const update = (method: PaymentMethod, change: Partial<RefundDraft>) =>
    onChange(drafts.map((d) => (d.method === method ? { ...d, ...change } : d)));
  return (
    <div className="space-y-3">
      {drafts.map((d) => {
        const available = refundable.find((r) => r.method === d.method)?.available ?? '0.00';
        return (
          <div key={d.method} className="grid gap-2 sm:grid-cols-2">
            <Field
              id={`refund-${d.method}`}
              label={PAYMENT_LABELS[d.method]}
              hint={`Up to ${formatMoney(available)}`}
              error={errors[`refund.${d.method}`]}
            >
              <MoneyInput
                value={d.amount}
                onChange={(e) => update(d.method, { amount: e.target.value })}
              />
            </Field>
            {d.method !== 'CASH' && (
              <Field id={`refund-${d.method}-ref`} label="Reference">
                <Input
                  value={d.reference}
                  onChange={(e) => update(d.method, { reference: e.target.value })}
                  placeholder={d.method === 'CARD' ? 'Approval code' : 'Transaction id'}
                  autoComplete="off"
                />
              </Field>
            )}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={cn(entered !== due && 'text-destructive')}>
          Split adds up to <span className="tabular-nums">{formatMoney(entered)}</span>
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          Reset to default
        </Button>
      </div>
      {errors.refunds && <FieldError>{errors.refunds}</FieldError>}
    </div>
  );
}
