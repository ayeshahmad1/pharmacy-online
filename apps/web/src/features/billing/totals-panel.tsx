import {
  BanknoteIcon,
  ListRestartIcon,
  PauseIcon,
  PercentIcon,
  PrinterIcon,
  ReceiptTextIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { MAX_CUSTOMER_NAME, type CartTotals } from './cart';

type Props = {
  totals: CartTotals;
  lineCount: number;
  units: number;
  heldCount: number;
  billDiscountError: string | null;
  customerName: string;
  onCustomerName: (name: string) => void;
  /** Enter or Esc in the customer name: back to the search box. */
  onCustomerNameDone: () => void;
  onBillDiscount: () => void;
  onPay: () => void;
  onHold: () => void;
  onHeldBills: () => void;
  onDaySlip: () => void;
  onReprint: () => void;
  onClear: () => void;
};

/**
 * The bill's totals and the actions that end it. On a tablet or phone it sits
 * under the cart as a sticky bar; every action has a large button as well as
 * its function key.
 */
export function TotalsPanel({
  totals,
  lineCount,
  units,
  heldCount,
  billDiscountError,
  customerName,
  onCustomerName,
  onCustomerNameDone,
  onBillDiscount,
  onPay,
  onHold,
  onHeldBills,
  onDaySlip,
  onReprint,
  onClear,
}: Props) {
  const empty = lineCount === 0;

  function onCustomerKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === 'Escape') {
      // Handled here: Esc must not also offer to clear the bill.
      event.preventDefault();
      onCustomerNameDone();
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-sm md:h-full md:p-4">
      <div className="relative">
        <UserIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Customer name (optional)"
          placeholder="Customer name (optional)"
          autoComplete="off"
          maxLength={MAX_CUSTOMER_NAME}
          className="h-10 pl-9"
          value={customerName}
          onChange={(e) => onCustomerName(e.target.value)}
          onKeyDown={onCustomerKey}
        />
      </div>
      <dl className="hidden gap-1.5 text-sm tabular-nums md:grid">
        <Line label={`Subtotal · ${units} ${units === 1 ? 'item' : 'items'}`}>
          {formatMoney(totals.subtotal)}
        </Line>
        {totals.lineDiscounts > 0n && (
          <Line label="Line discounts" tone="discount">
            −{formatMoney(totals.lineDiscounts)}
          </Line>
        )}
        <Line
          label={
            <button
              type="button"
              disabled={empty}
              onClick={onBillDiscount}
              className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"
            >
              <PercentIcon className="size-3.5" /> Bill discount <Kbd>F7</Kbd>
            </button>
          }
          tone={totals.billDiscount > 0n ? 'discount' : undefined}
        >
          {totals.billDiscount > 0n ? `−${formatMoney(totals.billDiscount)}` : '—'}
        </Line>
        {billDiscountError && (
          <p role="alert" className="text-sm text-destructive">
            {billDiscountError}
          </p>
        )}
      </dl>

      <div className="flex items-end justify-between gap-3 md:mt-auto md:block md:border-t md:pt-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Total
            <span className="md:hidden">
              {' '}
              · {units} {units === 1 ? 'item' : 'items'}
            </span>
            {totals.discountTotal > 0n && (
              <span className="text-emerald-700 dark:text-emerald-400">
                {' '}
                · saved {formatMoney(totals.discountTotal)}
              </span>
            )}
          </p>
          <p
            className="text-3xl font-bold tracking-tight tabular-nums md:text-4xl"
            aria-live="polite"
          >
            {formatMoney(totals.grandTotal)}
          </p>
        </div>
        <Button
          size="lg"
          className="h-14 min-w-36 text-lg md:mt-3 md:w-full"
          disabled={empty}
          onClick={onPay}
        >
          <BanknoteIcon className="size-5" /> Pay
          <Kbd className="hidden border-primary-foreground/30 sm:inline-flex bg-primary-foreground/15 text-primary-foreground">
            F8
          </Kbd>
        </Button>
      </div>

      <div className="grid grid-cols-5 gap-2 md:grid-cols-2">
        <ActionButton
          className="md:hidden"
          onClick={onBillDiscount}
          disabled={empty}
          icon={<PercentIcon />}
          label="Discount"
          shortcut="F7"
        />
        <ActionButton
          onClick={onHold}
          disabled={empty}
          icon={<PauseIcon />}
          label="Hold"
          shortcut="F9"
        />
        <ActionButton
          onClick={onHeldBills}
          icon={<ListRestartIcon />}
          label="Held bills"
          shortcut="F10"
          badge={heldCount}
        />
        <ActionButton
          onClick={onDaySlip}
          icon={<ReceiptTextIcon />}
          label="Day slip"
          shortcut="F3"
        />
        {/* Not in the phone's sticky bar, which has no room: Sales has it too. */}
        <ActionButton
          className="hidden md:flex"
          onClick={onReprint}
          icon={<PrinterIcon />}
          label="Reprint"
          shortcut="F1"
        />
        <ActionButton
          className="md:col-span-2"
          onClick={onClear}
          disabled={empty}
          icon={<XIcon />}
          label="Clear"
          shortcut="Esc"
          destructive
        />
      </div>
    </div>
  );
}

function Line({
  label,
  tone,
  children,
}: {
  label: ReactNode;
  tone?: 'discount';
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-medium',
          tone === 'discount' && 'text-emerald-700 dark:text-emerald-400',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  shortcut,
  badge,
  destructive,
  className,
  ...props
}: {
  icon: ReactNode;
  label: string;
  shortcut: string;
  badge?: number;
  destructive?: boolean;
  className?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      className={cn(
        'relative h-14 flex-col gap-0.5 px-2 text-xs md:h-12 md:flex-row md:gap-2 md:text-sm',
        destructive && 'hover:border-destructive/40 hover:text-destructive',
        className,
      )}
      {...props}
    >
      {icon}
      <span>{label}</span>
      <Kbd className="hidden lg:inline-flex">{shortcut}</Kbd>
      {!!badge && (
        <span className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-primary text-[0.7rem] font-semibold text-primary-foreground">
          {badge}
        </span>
      )}
    </Button>
  );
}
