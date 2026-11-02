import { PAYMENT_METHODS, type DaySalesDto } from '@pharmacy/shared';
import { useQuery } from '@tanstack/react-query';
import { PrinterIcon, RotateCwIcon } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { errorMessage, isUnreachable } from '@/lib/api';
import { formatDate, formatDateTime, formatTime } from '@/lib/format';
import { formatMoney, toPaisa } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useOffline } from '@/offline/offline-context';
import { billingApi, billingKeys } from './billing-api';
import { PAYMENT_LABELS } from './payments';
import { PrintArea, Row, Rule, amount, receiptConfig } from './receipt';

/**
 * The day-end slip for the 80mm receipt printer: every sale of the business
 * day (midnight to midnight, pharmacy time), one or two lines each, then the
 * day's totals. Everything comes from the server, so it shows what was saved.
 */
export function DaySlip({ day, printedAt }: { day: DaySalesDto; printedAt: string }) {
  const { totals } = day;
  return (
    <div className="receipt font-mono text-[12px] leading-snug text-black">
      <div className="text-center">
        <p className="text-[15px] font-bold">{receiptConfig.name}</p>
        {receiptConfig.address && <p>{receiptConfig.address}</p>}
        {receiptConfig.phone && <p>Tel: {receiptConfig.phone}</p>}
      </div>
      <Rule />
      <p className="text-center text-[14px] font-bold">DAY SALES</p>
      <Row left="Date" right={formatDate(day.date)} strong />
      <Row left="Cashier" right={day.cashier?.fullName ?? 'All cashiers'} />
      <Row left="Printed" right={formatDateTime(printedAt)} />
      <Rule />

      {day.sales.length === 0 && <p className="text-center">No sales on this day.</p>}
      {day.sales.map((sale) => {
        const voided = sale.status === 'VOIDED';
        return (
          <div key={sale.id} className="mb-1">
            <div className="flex justify-between gap-2">
              <span className="min-w-0">{sale.receiptNumber}</span>
              <span className={cn('shrink-0 tabular-nums', voided && 'line-through')}>
                {amount(sale.grandTotal)}
              </span>
            </div>
            <p className="pl-2 text-[11px]">
              {[
                formatTime(sale.soldAt),
                !day.cashier && sale.cashier.fullName,
                sale.paymentMethods.map((m) => PAYMENT_LABELS[m]).join(' + '),
              ]
                .filter(Boolean)
                .join(' · ')}
              {sale.status !== 'COMPLETED' && <span className="font-bold"> *{sale.status}*</span>}
            </p>
          </div>
        );
      })}

      <Rule />
      <Row left="Sales" right={String(totals.saleCount)} />
      <Row left="Items" right={String(totals.itemCount)} />
      {toPaisa(totals.discountTotal) !== 0n && (
        <Row left="Discounts given" right={`-${amount(totals.discountTotal)}`} />
      )}
      <div className="my-1 text-[15px]">
        <Row left="TOTAL" right={formatMoney(totals.grandTotal)} strong />
      </div>
      {PAYMENT_METHODS.map((m) => (
        <Row key={m} left={PAYMENT_LABELS[m]} right={amount(totals.byMethod[m])} />
      ))}
      {totals.voidedCount > 0 && (
        <>
          <Rule />
          <Row
            left={`Voided (${totals.voidedCount}), not counted`}
            right={amount(totals.voidedTotal)}
          />
        </>
      )}
      <Rule />
      <p className="text-center">End of day · {formatDate(day.date)}</p>
    </div>
  );
}

/**
 * Loads today's sales from the server and offers the slip for printing.
 * P prints; Esc closes. Needs the server: sales still queued on this device
 * aren't on it until they sync, and the dialog says so.
 */
export function DaySlipDialog({
  onClose,
  onCloseAutoFocus,
}: {
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const offline = useOffline();
  const day = useQuery({
    queryKey: billingKeys.daySales,
    queryFn: ({ signal }) => billingApi.daySales(signal),
    // Always fresh: the slip must include the sale rung up a moment ago.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const ready = !!day.data && !day.isFetching;
  // When this copy of the day was fetched; only read once data is here.
  const printedAt = new Date(day.dataUpdatedAt).toISOString();
  const unsynced = offline.summary.pending;

  function onKeyDown(event: KeyboardEvent) {
    if (event.key.toLowerCase() === 'p' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (ready) window.print();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" onKeyDown={onKeyDown} onCloseAutoFocus={onCloseAutoFocus}>
        {day.data && (
          <PrintArea>
            <DaySlip day={day.data} printedAt={printedAt} />
          </PrintArea>
        )}
        <DialogHeader>
          <DialogTitle>Day slip</DialogTitle>
          <DialogDescription>
            {day.data
              ? `${formatDate(day.data.date)} · ${day.data.totals.saleCount} ${day.data.totals.saleCount === 1 ? 'sale' : 'sales'} · ${formatMoney(day.data.totals.grandTotal)}`
              : 'Every sale of today, midnight to midnight, and the day’s total.'}
          </DialogDescription>
        </DialogHeader>

        {unsynced > 0 && (
          <p
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {unsynced} {unsynced === 1 ? 'sale' : 'sales'} made offline on this device{' '}
            {unsynced === 1 ? 'hasn’t' : 'haven’t'} synced yet and {unsynced === 1 ? 'is' : 'are'}{' '}
            not on the slip.
          </p>
        )}

        {day.isError && !day.data ? (
          <div role="alert" className="grid gap-3 rounded-lg bg-destructive/10 p-4 text-sm">
            <p className="text-destructive">
              {isUnreachable(day.error)
                ? 'Can’t reach the server. The day slip is built from the sales saved there, so it needs a connection.'
                : errorMessage(day.error)}
            </p>
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => void day.refetch()}
            >
              <RotateCwIcon /> Try again
            </Button>
          </div>
        ) : (
          /* The slip at its printed width (80mm ≈ 302px), on white like the paper. */
          <div className="mx-auto max-h-[55svh] w-full overflow-y-auto rounded-md border bg-white p-3 shadow-inner sm:w-[302px]">
            {day.data ? (
              <DaySlip day={day.data} printedAt={printedAt} />
            ) : (
              <p className="py-8 text-center text-sm text-neutral-500">Loading today’s sales…</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onClose}>
            Close <Kbd>Esc</Kbd>
          </Button>
          <Button size="lg" autoFocus disabled={!ready} onClick={() => window.print()}>
            <PrinterIcon /> Print slip
            <Kbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
              P
            </Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
