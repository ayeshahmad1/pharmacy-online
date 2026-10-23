import type { PaymentInput, PaymentMethod } from '@pharmacy/shared';
import { BanknoteIcon, CreditCardIcon, Loader2Icon, SmartphoneIcon } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { FieldError, FormAlert } from '@/components/form/field';
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
import { Kbd } from '@/components/ui/kbd';
import { formatMoney, paisaToAmount, toPaisa } from '@/lib/money';
import { cn } from '@/lib/utils';
import {
  PAYMENT_LABELS,
  cashSuggestions,
  emptyTenders,
  settle,
  toPayments,
  type TenderDraft,
} from './payments';

const ICONS: Record<PaymentMethod, typeof BanknoteIcon> = {
  CASH: BanknoteIcon,
  CARD: CreditCardIcon,
  MOBILE_WALLET: SmartphoneIcon,
};

/**
 * Takes payment for the bill: cash, card, mobile wallet, or a split of them.
 * Cash starts at the exact total, selected, so typing what the customer hands
 * over replaces it; Enter (or F8) completes the sale.
 */
export function PayDialog({
  grandTotal,
  pending,
  error,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  grandTotal: bigint;
  pending: boolean;
  /** Why the last attempt failed, if it did. */
  error: string | null;
  onConfirm: (payments: PaymentInput[]) => void;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [tenders, setTenders] = useState<TenderDraft[]>(() =>
    emptyTenders().map((t) =>
      t.method === 'CASH' && grandTotal > 0n ? { ...t, amount: paisaToAmount(grandTotal) } : t,
    ),
  );
  // Until the cashier types a cash amount, cash follows whatever card and wallet leave owing.
  const [cashTouched, setCashTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const settlement = settle(grandTotal, tenders);
  const cashDue = grandTotal - (settlement.nonCash > grandTotal ? grandTotal : settlement.nonCash);

  function setAmount(method: PaymentMethod, amount: string) {
    setTenders((ts) => {
      let next = ts.map((t) => (t.method === method ? { ...t, amount } : t));
      if (method !== 'CASH' && !cashTouched) {
        const nonCash = next
          .filter((t) => t.method !== 'CASH')
          .reduce((sum, t) => sum + (toPaisa(t.amount) ?? 0n), 0n);
        const rest = grandTotal - nonCash;
        next = next.map((t) =>
          t.method === 'CASH' ? { ...t, amount: rest > 0n ? paisaToAmount(rest) : '' } : t,
        );
      }
      return next;
    });
  }

  function setReference(method: PaymentMethod, reference: string) {
    setTenders((ts) => ts.map((t) => (t.method === method ? { ...t, reference } : t)));
  }

  /** Puts whatever is still owed on this method. */
  function fillRest(method: PaymentMethod) {
    const others = tenders
      .filter((t) => t.method !== method)
      .reduce((sum, t) => sum + (toPaisa(t.amount) ?? 0n), 0n);
    const rest = grandTotal - others;
    if (method === 'CASH') setCashTouched(true);
    setAmount(method, rest > 0n ? paisaToAmount(rest) : '');
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    setSubmitted(true);
    if (pending || !settlement.ok) return;
    onConfirm(toPayments(tenders));
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'F8') {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        className="max-w-xl"
        onKeyDown={onKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={(e) => pending && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>
            Split across methods if needed. Change is only given from cash.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-baseline justify-between rounded-lg bg-primary/10 px-4 py-3">
          <span className="text-sm font-medium">Amount due</span>
          <span className="text-3xl font-bold tabular-nums">{formatMoney(grandTotal)}</span>
        </div>

        <form onSubmit={submit} className="grid gap-3">
          <fieldset disabled={pending} className="grid gap-3">
            {tenders.map((t) => {
              const Icon = ICONS[t.method];
              const id = `pay-${t.method}`;
              const fieldError = settlement.fieldErrors[t.method];
              return (
                <div key={t.method} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-center gap-3">
                    <label
                      htmlFor={id}
                      className="flex w-36 shrink-0 items-center gap-2 font-medium"
                    >
                      <Icon className="size-5 text-muted-foreground" />
                      {PAYMENT_LABELS[t.method]}
                    </label>
                    <MoneyInput
                      id={id}
                      className="flex-1"
                      autoFocus={t.method === 'CASH'}
                      onFocus={(e) => e.target.select()}
                      value={t.amount}
                      aria-invalid={!!fieldError}
                      onChange={(e) => {
                        if (t.method === 'CASH') setCashTouched(true);
                        setAmount(t.method, e.target.value);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      tabIndex={-1}
                      onClick={() => fillRest(t.method)}
                    >
                      Rest
                    </Button>
                  </div>
                  {fieldError && <FieldError>{fieldError}</FieldError>}
                  {t.method === 'CASH' ? (
                    <div className="flex flex-wrap gap-2 pl-0 sm:pl-39">
                      {cashSuggestions(cashDue).map((amount) => (
                        <Button
                          key={String(amount)}
                          type="button"
                          variant="secondary"
                          size="sm"
                          tabIndex={-1}
                          className="tabular-nums"
                          onClick={() => {
                            setCashTouched(true);
                            setAmount('CASH', paisaToAmount(amount));
                          }}
                        >
                          {formatMoney(amount)}
                        </Button>
                      ))}
                    </div>
                  ) : toPaisa(t.amount) ? (
                    <Input
                      aria-label={`${PAYMENT_LABELS[t.method]} reference`}
                      placeholder={
                        t.method === 'CARD'
                          ? 'Approval code (optional)'
                          : 'Transaction id (optional)'
                      }
                      value={t.reference}
                      maxLength={100}
                      onChange={(e) => setReference(t.method, e.target.value)}
                      className="sm:ml-39 sm:w-auto"
                    />
                  ) : null}
                </div>
              );
            })}
          </fieldset>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/60 px-4 py-3 tabular-nums">
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="text-right font-medium">{formatMoney(settlement.paid)}</dd>
            {settlement.remaining > 0n ? (
              <>
                <dt className="font-medium text-destructive">Still to pay</dt>
                <dd className="text-right text-xl font-bold text-destructive">
                  {formatMoney(settlement.remaining)}
                </dd>
              </>
            ) : (
              <>
                <dt className="font-medium">Change</dt>
                <dd
                  className={cn(
                    'text-right text-3xl font-bold',
                    settlement.change > 0n && 'text-emerald-700 dark:text-emerald-400',
                  )}
                >
                  {formatMoney(settlement.change)}
                </dd>
              </>
            )}
          </dl>

          {(error ?? (submitted && settlement.error)) && (
            <FormAlert>{error ?? settlement.error}</FormAlert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Back <Kbd>Esc</Kbd>
            </Button>
            <Button type="submit" size="lg" disabled={pending} className="min-w-48">
              {pending && <Loader2Icon className="animate-spin" />}
              {pending ? 'Saving…' : 'Complete sale'}
              {!pending && (
                <Kbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
                  Enter
                </Kbd>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
