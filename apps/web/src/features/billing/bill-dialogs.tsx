import type { SaleDto } from '@pharmacy/shared';
import { CircleCheckIcon, CloudOffIcon, PauseIcon, PrinterIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
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
import { Label } from '@/components/ui/label';
import type { HeldBill } from '@/offline/held-bills';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { cartUnits } from './cart';
import { Receipt, ReceiptPrintArea } from './receipt';

type CloseFocus = { onCloseAutoFocus: (event: Event) => void };

// ─── Sale complete ──────────────────────────────────────────────────────────

const AUTO_PRINT_KEY = 'billing.autoPrint';

function readAutoPrint() {
  try {
    return localStorage.getItem(AUTO_PRINT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The saved sale: change to hand back, the receipt as it will print, and the
 * way to the next customer. P prints; Enter or Esc starts a new sale. A sale
 * made offline (`provisional`) is shown as saved on this device, with its
 * offline reference until the server numbers it.
 */
export function SaleCompleteDialog({
  sale,
  replayed,
  provisional = false,
  onNewSale,
  onCloseAutoFocus,
}: {
  sale: SaleDto;
  replayed: boolean;
  provisional?: boolean;
  onNewSale: () => void;
} & CloseFocus) {
  // A per-device preference, so it lives in localStorage rather than the database.
  const [autoPrint, setAutoPrint] = useState(readAutoPrint);

  useEffect(() => {
    if (!readAutoPrint()) return;
    // Let the print area mount first.
    const timer = setTimeout(() => window.print(), 50);
    return () => clearTimeout(timer);
  }, []);

  function toggleAutoPrint(on: boolean) {
    setAutoPrint(on);
    try {
      localStorage.setItem(AUTO_PRINT_KEY, on ? '1' : '0');
    } catch {
      // Storage blocked: the setting lasts for this screen only.
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key.toLowerCase() === 'p' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.print();
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      onNewSale();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onNewSale()}>
      <DialogContent
        className="max-w-2xl"
        onKeyDown={onKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ReceiptPrintArea sale={sale} provisional={provisional} />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {provisional ? (
              <CloudOffIcon className="size-6 text-amber-600" />
            ) : (
              <CircleCheckIcon className="size-6 text-emerald-600" />
            )}
            {provisional ? 'Saved offline' : 'Sale saved'} · {sale.receiptNumber}
          </DialogTitle>
          <DialogDescription>
            {provisional
              ? 'Kept on this device and sent to the server automatically when the connection returns; the receipt number is assigned then.'
              : replayed
                ? 'This bill had already been saved by an earlier attempt; this is that sale. Nothing was charged twice.'
                : `${formatDateTime(sale.soldAt)} · ${sale.cashier.fullName}`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="grid content-start gap-3">
            <div className="rounded-lg bg-muted/60 p-4">
              <p className="text-sm text-muted-foreground">Total</p>
              <p className="text-2xl font-bold tabular-nums">{formatMoney(sale.grandTotal)}</p>
            </div>
            <div
              className={cn(
                'rounded-lg p-4',
                sale.changeDue !== '0.00' ? 'bg-emerald-100 dark:bg-emerald-950/50' : 'bg-muted/60',
              )}
            >
              <p className="text-sm text-muted-foreground">Change to give</p>
              <p className="text-4xl font-bold tabular-nums">{formatMoney(sale.changeDue)}</p>
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={autoPrint}
                onChange={(e) => toggleAutoPrint(e.target.checked)}
              />
              Print the receipt automatically after each sale
            </label>
          </div>
          {/* The receipt at its printed width (80mm ≈ 302px), on white like the paper. */}
          <div className="max-h-[50svh] overflow-y-auto rounded-md border bg-white p-3 shadow-inner sm:w-[302px]">
            <Receipt sale={sale} provisional={provisional} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => window.print()}>
            <PrinterIcon /> Print receipt <Kbd>P</Kbd>
          </Button>
          <Button size="lg" autoFocus onClick={onNewSale} className="min-w-40">
            New sale
            <Kbd className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground">
              Enter
            </Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Hold ───────────────────────────────────────────────────────────────────

/** Puts the bill aside with an optional label, e.g. the customer's name. */
export function HoldDialog({
  total,
  onHold,
  onClose,
  onCloseAutoFocus,
}: { total: bigint; onHold: (label: string) => void; onClose: () => void } & CloseFocus) {
  const [label, setLabel] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    onHold(label.trim());
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Hold this bill</DialogTitle>
          <DialogDescription>
            {formatMoney(total)}. Held bills stay on this device until resumed. Prices and stock are
            checked again when you resume.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="hold-label">Label (optional)</Label>
            <Input
              id="hold-label"
              autoFocus
              maxLength={60}
              placeholder="e.g. customer name or phone"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              <PauseIcon /> Hold bill
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Held bills ─────────────────────────────────────────────────────────────

/** Bills on hold on this device. ↑/↓ choose, Enter resumes, Delete discards. */
export function HeldBillsDialog({
  bills,
  loading,
  currentHasItems,
  onResume,
  onDiscard,
  onClose,
  onCloseAutoFocus,
}: {
  bills: HeldBill[];
  loading: boolean;
  currentHasItems: boolean;
  onResume: (bill: HeldBill) => void;
  onDiscard: (bill: HeldBill) => void;
  onClose: () => void;
} & CloseFocus) {
  const [index, setIndex] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const active = Math.min(index, bills.length - 1);

  function onKeyDown(event: KeyboardEvent) {
    if (bills.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setIndex((active + step + bills.length) % bills.length);
      setConfirmDiscard(null);
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      onResume(bills[active]!);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const bill = bills[active]!;
      if (confirmDiscard === bill.id) onDiscard(bill);
      else setConfirmDiscard(bill.id);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-xl"
        onKeyDown={onKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
        // Focus the list, not the first row's discard button, so Enter resumes.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          listRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Held bills</DialogTitle>
          <DialogDescription>
            {currentHasItems
              ? 'Resuming puts the bill you are working on on hold first.'
              : 'Pick a bill to carry on with it.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : bills.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No bills are on hold.</p>
        ) : (
          <ul
            className="-mx-2 max-h-[55svh] divide-y overflow-y-auto outline-none"
            ref={listRef}
            tabIndex={-1}
            role="listbox"
            aria-label="Held bills"
          >
            {bills.map((bill, i) => (
              <li
                key={bill.id}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setIndex(i)}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2 py-2.5',
                  i === active && 'bg-accent',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {bill.label ||
                      `${bill.cart.lines[0]?.medicine.name ?? 'Bill'}${bill.cart.lines.length > 1 ? ` + ${bill.cart.lines.length - 1} more` : ''}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTime(bill.heldAt)} · {bill.heldBy.fullName} · {cartUnits(bill.cart)}{' '}
                    {cartUnits(bill.cart) === 1 ? 'item' : 'items'}
                  </p>
                </div>
                <span className="font-semibold tabular-nums">{formatMoney(bill.total)}</span>
                {confirmDiscard === bill.id ? (
                  <Button variant="destructive" size="sm" onClick={() => onDiscard(bill)}>
                    Discard?
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Discard held bill"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmDiscard(bill.id)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
                <Button size="sm" onClick={() => onResume(bill)}>
                  Resume
                </Button>
              </li>
            ))}
          </ul>
        )}
        {bills.length > 0 && (
          <p className="hidden text-xs text-muted-foreground sm:block">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> choose · <Kbd>Enter</Kbd> resume · <Kbd>Del</Kbd> twice to
            discard
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Clear ──────────────────────────────────────────────────────────────────

/** Confirms emptying the bill. Enter clears (the button has focus); Esc keeps it. */
export function ClearBillDialog({
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: { onConfirm: () => void; onClose: () => void } & CloseFocus) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Clear this bill?</DialogTitle>
          <DialogDescription>
            Every item and discount is removed. Nothing has been charged. Hold it instead (F9) to
            keep it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep bill <Kbd>Esc</Kbd>
          </Button>
          <Button variant="destructive" autoFocus onClick={onConfirm}>
            Clear bill <Kbd className="border-white/30 bg-white/15 text-white">Enter</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
