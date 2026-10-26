import type { ReturnSummaryDto, SaleDto } from '@pharmacy/shared';
import { useQuery } from '@tanstack/react-query';
import { BanIcon, PrinterIcon, Undo2Icon } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { BackLink, DetailError, DetailSkeleton, Facts } from '@/components/data/detail-states';
import { ErrorState, TableSkeleton } from '@/components/data/list-states';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCurrentUser } from '@/features/auth/auth-context';
import { PAYMENT_LABELS } from '@/features/billing/payments';
import { ReceiptPrintArea } from '@/features/billing/receipt';
import { returnsApi, returnsKeys } from '@/features/returns/returns-api';
import { formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { formatMoney, toPaisa } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { returnBlocker, voidBlocker } from './sale-actions';
import { salesApi, salesKeys } from './sales-api';
import { ReturnStatusBadge, SaleStatusBadge } from './status-badges';
import { VoidSaleDialog } from './void-sale-dialog';

const isZero = (amount: string) => toPaisa(amount) === 0n;

export function SaleDetailPage() {
  const { id = '' } = useParams();
  const sale = useQuery({
    queryKey: salesKeys.detail(id),
    queryFn: ({ signal }) => salesApi.get(id, signal),
  });

  if (sale.isPending) return <DetailSkeleton />;
  if (sale.isError) {
    return (
      <DetailError
        error={sale.error}
        onRetry={() => void sale.refetch()}
        retrying={sale.isFetching}
        missingTitle="Sale not found"
        missingDescription="Check the receipt number. Cashiers can only open the sales they rang up."
        backTo="/sales"
        backLabel="Back to sales"
      />
    );
  }
  return <SaleDetail sale={sale.data} />;
}

function SaleDetail({ sale }: { sale: SaleDto }) {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const [voiding, setVoiding] = useState(false);

  // Cashiers only get back the returns they raised; staff get every one.
  const returnsQuery = { saleId: sale.id, pageSize: 100 };
  const returns = useQuery({
    queryKey: returnsKeys.list(returnsQuery),
    queryFn: ({ signal }) => returnsApi.list(returnsQuery, signal),
  });

  const cannotReturn = returnBlocker(sale);
  const cannotVoid = returns.data ? voidBlocker(sale, returns.data.items) : null;
  const units = sale.items.reduce((sum, i) => sum + i.quantity, 0);

  // P reprints, as on the sale-complete screen, unless the user is typing or a dialog is open.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing =
      target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (voiding || typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'p' || event.key === 'P') {
      event.preventDefault();
      window.print();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return (
    <div className="space-y-6">
      <ReceiptPrintArea sale={sale} />
      <div className="space-y-3">
        <BackLink to="/sales">{isStaff ? 'Sales' : 'My sales'}</BackLink>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-2xl font-semibold">{sale.receiptNumber}</h2>
              <SaleStatusBadge status={sale.status} />
            </div>
            <p className="text-muted-foreground">
              {formatDateTime(sale.soldAt)} · {sale.cashier.fullName}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => window.print()}>
              <PrinterIcon /> Reprint receipt <Kbd>P</Kbd>
            </Button>
            {!cannotReturn && (
              <Button asChild>
                <Link to={`/returns/new?saleId=${sale.id}`}>
                  <Undo2Icon /> Return items
                </Link>
              </Button>
            )}
            {isStaff && sale.status === 'COMPLETED' && (
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={!returns.data || !!cannotVoid}
                onClick={() => setVoiding(true)}
                aria-describedby={cannotVoid ? 'void-blocked' : undefined}
              >
                <BanIcon /> Void sale
              </Button>
            )}
          </div>
        </div>
        {isStaff && sale.status === 'COMPLETED' && cannotVoid && (
          <p id="void-blocked" className="text-sm text-muted-foreground sm:text-right">
            Cannot void: {cannotVoid}
          </p>
        )}
      </div>

      {sale.status === 'VOIDED' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <p className="font-medium">
            Voided {sale.voidedAt && formatDateTime(sale.voidedAt)}
            {sale.voidedBy && ` by ${sale.voidedBy.fullName}`}
          </p>
          {sale.voidReason && <p className="mt-1">Reason: {sale.voidReason}</p>}
          <p className="mt-1">Every unit went back to its batch.</p>
        </div>
      )}

      <Facts
        items={[
          ['Total', <span className="tabular-nums">{formatMoney(sale.grandTotal)}</span>],
          ['Items', units],
          [
            'Discount',
            <span className="tabular-nums">
              {isZero(sale.discountTotal) ? '—' : formatMoney(sale.discountTotal)}
            </span>,
          ],
          ['Tendered', <span className="tabular-nums">{formatMoney(sale.amountTendered)}</span>],
          [
            'Change',
            <span className="tabular-nums">
              {isZero(sale.changeDue) ? '—' : formatMoney(sale.changeDue)}
            </span>,
          ],
        ]}
      />

      <SaleLines sale={sale} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Payments sale={sale} />
        <section className="space-y-3" aria-labelledby="sale-notes-heading">
          <h3 id="sale-notes-heading" className="text-lg font-semibold">
            Notes
          </h3>
          <p className="rounded-lg border p-4 text-sm whitespace-pre-wrap text-muted-foreground">
            {sale.notes ?? 'No notes on this sale.'}
          </p>
        </section>
      </div>

      <section className="space-y-3" aria-labelledby="sale-returns-heading">
        <h3 id="sale-returns-heading" className="text-lg font-semibold">
          Returns against this sale
        </h3>
        {returns.isPending ? (
          <TableSkeleton rows={2} columns={4} />
        ) : returns.isError ? (
          <ErrorState
            error={returns.error}
            onRetry={() => void returns.refetch()}
            retrying={returns.isFetching}
          />
        ) : (
          <ReturnsList returns={returns.data.items} isStaff={isStaff} />
        )}
      </section>

      {voiding && <VoidSaleDialog sale={sale} onClose={() => setVoiding(false)} />}
    </div>
  );
}

function SaleLines({ sale }: { sale: SaleDto }) {
  return (
    <section className="space-y-3" aria-labelledby="sale-lines-heading">
      <h3 id="sale-lines-heading" className="text-lg font-semibold">
        Items
      </h3>
      <p className="text-sm text-muted-foreground">
        One line per batch: a medicine sold from several batches (earliest expiry first) shows on
        several lines.
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Medicine</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Price</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Discount</TableHead>
              <TableHead className="text-right">Line total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sale.items.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="min-w-40 whitespace-normal">
                  <span className="font-medium">{line.medicine.name}</span>
                  {line.medicine.genericName && (
                    <p className="text-xs text-muted-foreground">{line.medicine.genericName}</p>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="font-mono text-sm">{line.batch.batchNumber}</span>
                  <p className="text-xs text-muted-foreground">
                    Exp {formatDate(line.batch.expiryDate)}
                  </p>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatQuantity(line.quantity, line.medicine.unit)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {formatMoney(line.unitPrice)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {isZero(line.discount) ? '—' : `−${formatMoney(line.discount)}`}
                </TableCell>
                <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                  {formatMoney(line.lineTotal)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="text-right">
                Subtotal
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoney(sale.subtotal)}
              </TableCell>
            </TableRow>
            {!isZero(sale.discountTotal) && (
              <TableRow>
                <TableCell colSpan={5} className="text-right">
                  Discounts (line and bill)
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  −{formatMoney(sale.discountTotal)}
                </TableCell>
              </TableRow>
            )}
            <TableRow>
              <TableCell colSpan={5} className="text-right font-semibold">
                Total
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatMoney(sale.grandTotal)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </section>
  );
}

function Payments({ sale }: { sale: SaleDto }) {
  return (
    <section className="space-y-3" aria-labelledby="sale-payments-heading">
      <h3 id="sale-payments-heading" className="text-lg font-semibold">
        Payments
      </h3>
      {sale.payments.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">
          Nothing was paid: the bill was fully discounted.
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Applied</TableHead>
                <TableHead className="text-right">Handed over</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sale.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {PAYMENT_LABELS[p.method]}
                    {p.reference && (
                      <p className="font-mono text-xs text-muted-foreground">{p.reference}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(p.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(p.tendered ?? p.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {!isZero(sale.changeDue) && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="text-right">
                    Change given (from cash)
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(sale.changeDue)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
    </section>
  );
}

function ReturnsList({ returns, isStaff }: { returns: ReturnSummaryDto[]; isStaff: boolean }) {
  if (returns.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {isStaff
          ? 'No returns against this sale.'
          : 'You have raised no returns against this sale.'}
      </p>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Return</TableHead>
            <TableHead>Raised</TableHead>
            <TableHead className="hidden sm:table-cell">By</TableHead>
            <TableHead className="text-right">Refund</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {returns.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-sm whitespace-nowrap">
                <Link to={`/returns/${r.id}`} className="font-medium hover:underline">
                  {r.returnNumber}
                </Link>
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatDateTime(r.requestedAt)}</TableCell>
              <TableCell className="hidden sm:table-cell">{r.requestedBy.fullName}</TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                {formatMoney(r.refundTotal)}
              </TableCell>
              <TableCell>
                <ReturnStatusBadge status={r.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
