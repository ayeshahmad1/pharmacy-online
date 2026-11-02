import type { PaymentInput, SaleDto, SellableMedicineDto } from '@pharmacy/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOffIcon, OctagonAlertIcon, XIcon } from 'lucide-react';
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/features/auth/auth-context';
import { invalidateStock } from '@/features/inventory/inventory-api';
import { errorMessage, isUnreachable } from '@/lib/api';
import { connectivity } from '@/lib/connectivity';
import { formatDateTime, formatQuantity } from '@/lib/format';
import { paisaToAmount } from '@/lib/money';
import { cn } from '@/lib/utils';
import { offlineBilling } from '@/offline/catalogue-store';
import { drafts, heldBills, type HeldBill } from '@/offline/held-bills';
import { useOffline } from '@/offline/offline-context';
import { newQueuedSale, saleQueue } from '@/offline/sale-queue';
import { ClearBillDialog, HeldBillsDialog, HoldDialog, SaleCompleteDialog } from './bill-dialogs';
import { billingApi, billingKeys } from './billing-api';
import {
  MAX_CART_LINES,
  addToCart,
  cartUnits,
  lineGross,
  newCart,
  priceCart,
  removeLine,
  setLineDiscount,
  setQuantity,
  toSaleBody,
  type Cart,
  type CartLine,
  type DiscountDraft,
} from './cart';
import { CartKeysHint, CartList, focusQuantity } from './cart-list';
import { DaySlipDialog } from './day-slip';
import { DiscountDialog, type DiscountTarget } from './discount-dialog';
import { errorBeep } from './feedback';
import { MedicineSearch } from './medicine-search';
import { buildOfflineSale, checkOfflineSale } from './offline-sale';
import { PayDialog } from './pay-dialog';
import { saleProblem, type SaleProblem } from './sale-errors';
import { TotalsPanel } from './totals-panel';

const isTypedCharacter = (event: KeyboardEvent) =>
  event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

const isTextField = (el: Element | null) =>
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit'].includes(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

type DialogState =
  | null
  | { type: 'pay' }
  | { type: 'discount'; medicineId: string | null }
  | { type: 'hold' }
  | { type: 'held' }
  | { type: 'clear' }
  | { type: 'daySlip' }
  | { type: 'done'; sale: SaleDto; replayed: boolean; provisional: boolean };

/** The sale went to the server, or was queued on this device to sync later. */
type SellResult =
  { kind: 'saved'; sale: SaleDto; replayed: boolean } | { kind: 'queued'; sale: SaleDto };

/** This device can't vouch for the sale offline; nothing was queued. */
class OfflineSaleRefused extends Error {
  constructor(readonly problem: SaleProblem) {
    super(problem.message);
  }
}

/** How long the cart may go unsaved on this device after a change. */
const DRAFT_SAVE_DELAY_MS = 250;

/**
 * The counter's billing screen. Keyboard first: the search box always has
 * focus between actions, a scanner's Enter adds the item, and every action
 * has a function key (F2 search, F3 day slip, F4 quantity, F6/F7 discounts,
 * F8 pay, F9 hold, F10 held bills, Esc clear). Every control is also a large button
 * for touch use on a tablet.
 *
 * The cart is saved on this device as it changes, so a reload, a dropped
 * session or a visit to another screen doesn't lose it.
 *
 * Offline (or when the server stops answering mid-sale), lookups come from
 * the medicine list saved on this device and a paid bill is queued there,
 * under its own idempotency key, to sync when the connection returns.
 */
export function BillingPage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const offline = useOffline();
  const searchRef = useRef<HTMLInputElement>(null);

  const [cart, setCart] = useState<Cart>(newCart);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [problem, setProblem] = useState<SaleProblem | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [substitutesFor, setSubstitutesFor] = useState<SellableMedicineDto | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const totals = useMemo(() => priceCart(cart), [cart]);
  const units = cartUnits(cart);
  const selectedLine = cart.lines.find((l) => l.medicine.id === selectedId) ?? null;

  const held = useQuery({
    queryKey: billingKeys.heldBills,
    queryFn: () => heldBills.list(),
    // Local data: always available, even offline.
    networkMode: 'always',
    staleTime: Infinity,
  });

  function focusSearch() {
    requestAnimationFrame(() => {
      // A dialog opened in the meantime (F8 straight after Enter) keeps focus.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }

  /** Dialogs hand focus back to the search box, not to the button that opened them. */
  function returnFocus(event: Event) {
    event.preventDefault();
    focusSearch();
  }

  // ─── Draft on this device ─────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    drafts
      .get(user.id)
      .then((draft) => {
        if (cancelled || !draft || draft.lines.length === 0) return;
        setCart(draft);
        setSelectedId(draft.lines.at(-1)!.medicine.id);
        toast.info('Restored the bill you were working on');
        void refreshLines(draft.lines);
      })
      .catch(() => {
        // No local storage: the cart simply isn't kept across reloads.
      })
      .finally(() => {
        if (!cancelled) setDraftLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const saveDraft = useEffectEvent(() => {
    const write = cart.lines.length > 0 ? drafts.save(user.id, cart) : drafts.clear(user.id);
    write.catch(() => undefined);
  });

  useEffect(() => {
    if (!draftLoaded) return;
    const timer = setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [cart, draftLoaded]);

  useEffect(() => {
    // Closing the tab inside the save delay must not lose the last change.
    const flush = () => draftLoaded && saveDraft();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [draftLoaded]);

  /**
   * Re-reads price and stock for lines that came from storage (a held bill
   * or a restored draft), so the totals match what the API will charge.
   */
  async function refreshLines(lines: CartLine[]) {
    const results = await Promise.allSettled(lines.map((l) => billingApi.get(l.medicine.id)));
    const fresh = new Map<string, SellableMedicineDto>();
    for (const r of results) if (r.status === 'fulfilled') fresh.set(r.value.id, r.value);
    if (fresh.size === 0) return;

    const repriced = lines
      .filter((l) => {
        const now = fresh.get(l.medicine.id);
        return now && now.sellingPrice !== l.medicine.sellingPrice;
      })
      .map((l) => l.medicine.name);
    setCart((c) => ({
      ...c,
      lines: c.lines.map((l) => {
        const now = fresh.get(l.medicine.id);
        return now ? { ...l, medicine: now } : l;
      }),
    }));
    if (repriced.length > 0) {
      toast.warning(`Price changed since this bill was started: ${repriced.join(', ')}`);
    }
  }

  // ─── Cart edits ───────────────────────────────────────────────────────────

  /** Clears the API's complaint about what was just edited. */
  function clearProblem(edited: { medicineId: string } | 'bill') {
    setPayError(null);
    setProblem((p) => {
      if (!p) return null;
      const lines = { ...p.lines };
      if (edited !== 'bill') delete lines[edited.medicineId];
      const billDiscount = edited === 'bill' ? null : p.billDiscount;
      return Object.keys(lines).length > 0 || billDiscount
        ? { ...p, lines, billDiscount, payment: null }
        : null;
    });
  }

  function add(medicine: SellableMedicineDto, quantity: number) {
    const existing = cart.lines.find((l) => l.medicine.id === medicine.id);
    if (!existing && cart.lines.length >= MAX_CART_LINES) {
      errorBeep();
      toast.error(`A bill can have at most ${MAX_CART_LINES} lines. Pay or hold this one first.`);
      return;
    }
    const total = (existing?.quantity ?? 0) + quantity;
    if (total > medicine.sellableQuantity) {
      errorBeep();
      toast.warning(
        `Only ${formatQuantity(medicine.sellableQuantity, medicine.unit)} of ${medicine.name} in stock`,
      );
    }
    setCart((c) => addToCart(c, medicine, quantity));
    setSelectedId(medicine.id);
    clearProblem({ medicineId: medicine.id });
  }

  function changeQuantity(medicineId: string, quantity: number) {
    setCart((c) => setQuantity(c, medicineId, quantity));
    clearProblem({ medicineId });
  }

  function remove(medicineId: string) {
    const index = cart.lines.findIndex((l) => l.medicine.id === medicineId);
    const next = cart.lines[index + 1] ?? cart.lines[index - 1];
    setCart((c) => removeLine(c, medicineId));
    setSelectedId(next?.medicine.id ?? null);
    clearProblem({ medicineId });
    focusSearch();
  }

  function applyDiscount(medicineId: string | null, discount: DiscountDraft | null) {
    if (medicineId) {
      setCart((c) => setLineDiscount(c, medicineId, discount));
      clearProblem({ medicineId });
    } else {
      setCart((c) => ({ ...c, discount }));
      clearProblem('bill');
    }
    setDialog(null);
  }

  /** Starts a fresh bill with a new idempotency key. */
  function resetBill() {
    setCart(newCart());
    setSelectedId(null);
    setProblem(null);
    setPayError(null);
    setSubstitutesFor(null);
  }

  // Keys pressed in the empty search box act on the selected cart line.
  function onIdleKey(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
    if (cart.lines.length === 0) return false;
    const index = cart.lines.findIndex((l) => l.medicine.id === selectedId);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const from = index === -1 ? (step === 1 ? -1 : cart.lines.length) : index;
        const next = cart.lines[Math.min(cart.lines.length - 1, Math.max(0, from + step))]!;
        setSelectedId(next.medicine.id);
        return true;
      }
      case '+':
      case '=':
        if (!selectedLine) return false;
        changeQuantity(selectedLine.medicine.id, selectedLine.quantity + 1);
        return true;
      case '-':
        if (!selectedLine) return false;
        changeQuantity(selectedLine.medicine.id, selectedLine.quantity - 1);
        return true;
      case 'Delete':
        if (!selectedLine) return false;
        remove(selectedLine.medicine.id);
        return true;
    }
    return false;
  }

  // ─── Payment ──────────────────────────────────────────────────────────────

  /**
   * Queues the bill on this device, if the device's own stock count and the
   * cashier cap allow it. Same idempotency key as any online attempt, so a
   * sale the server did save (reply lost) replays instead of doubling.
   */
  async function queueOffline(payments: PaymentInput[]): Promise<SaleDto> {
    const local = await offlineBilling.forSale(cart.lines.map((l) => l.medicine.id));
    const problem = checkOfflineSale(cart, totals, {
      stock: local?.stock ?? new Map<string, SellableMedicineDto>(),
      cashierMaxDiscountPercent: local?.meta.cashierMaxDiscountPercent ?? null,
      role: user.role,
    });
    if (problem || !local) throw new OfflineSaleRefused(problem!);
    const { body, receipt } = buildOfflineSale({
      cart,
      totals,
      payments,
      user,
      batches: local.batches,
      today: local.today,
      now: new Date(),
    });
    await saleQueue.put(newQueuedSale({ body, receipt, user }));
    return receipt;
  }

  const sell = useMutation({
    mutationFn: async (payments: PaymentInput[]): Promise<SellResult> => {
      if (connectivity.get().online) {
        try {
          return { kind: 'saved', ...(await billingApi.createSale(toSaleBody(cart, payments))) };
        } catch (err) {
          // The server never answered: the sale may or may not be saved there.
          // Queue it under the same key; the sync replays or saves it.
          if (!isUnreachable(err)) throw err;
        }
      }
      return { kind: 'queued', sale: await queueOffline(payments) };
    },
    // Runs offline too: that is when queueing matters.
    networkMode: 'always',
    meta: { skipErrorToast: true },
    onSuccess: (result) => {
      resetBill();
      setDialog({
        type: 'done',
        sale: result.sale,
        replayed: result.kind === 'saved' && result.replayed,
        provisional: result.kind === 'queued',
      });
      drafts.clear(user.id).catch(() => undefined);
      // Stock just changed: search results and stock screens must not show the old numbers.
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      if (result.kind === 'saved') void invalidateStock(queryClient);
      else offline.syncNow();
    },
    onError: (err) => {
      errorBeep();
      const p = err instanceof OfflineSaleRefused ? err.problem : saleProblem(err, cart);
      if (p.stockUpdates.length > 0) {
        const updates = new Map(p.stockUpdates.map((u) => [u.medicineId, u]));
        setCart((c) => ({
          ...c,
          lines: c.lines.map((l) => {
            const u = updates.get(l.medicine.id);
            return u
              ? {
                  ...l,
                  medicine: {
                    ...l.medicine,
                    sellableQuantity: u.available,
                    expiredQuantity: u.expired,
                  },
                }
              : l;
          }),
        }));
      }
      // A price may have changed under the bill; show the current one.
      if (p.payment) void refreshLines(cart.lines);

      const aboutTheCart = Object.keys(p.lines).length > 0 || !!p.billDiscount || p.alreadySaved;
      if (aboutTheCart) {
        // Close the pay dialog so the cashier sees the marked lines.
        setDialog(null);
        setProblem(p);
        const first = Object.keys(p.lines)[0];
        if (first) setSelectedId(first);
      } else {
        setPayError(p.payment ?? p.message);
      }
    },
  });

  function openPay() {
    if (cart.lines.length === 0) {
      errorBeep();
      return;
    }
    if (!totals.valid) {
      errorBeep();
      toast.error('Fix the discounts marked in red first');
      return;
    }
    if (problem?.alreadySaved) {
      errorBeep();
      return;
    }
    setPayError(null);
    setDialog({ type: 'pay' });
  }

  function pay(payments: PaymentInput[]) {
    setPayError(null);
    sell.mutate(payments);
  }

  // ─── Hold and resume ──────────────────────────────────────────────────────

  async function holdCurrent(label: string): Promise<boolean> {
    const bill: HeldBill = {
      id: crypto.randomUUID(),
      cart,
      label,
      heldAt: new Date().toISOString(),
      heldBy: { id: user.id, fullName: user.fullName },
      total: paisaToAmount(totals.grandTotal),
    };
    try {
      await heldBills.save(bill);
    } catch (err) {
      errorBeep();
      toast.error(`Could not hold the bill: ${errorMessage(err)}`);
      return false;
    }
    void queryClient.invalidateQueries({ queryKey: billingKeys.heldBills });
    return true;
  }

  async function hold(label: string) {
    if (!(await holdCurrent(label))) return;
    resetBill();
    setDialog(null);
    toast.success(label ? `Bill held: ${label}` : 'Bill held');
  }

  async function resume(bill: HeldBill) {
    if (cart.lines.length > 0 && !(await holdCurrent(''))) return;
    try {
      await heldBills.remove(bill.id);
    } catch (err) {
      toast.error(`Could not resume the bill: ${errorMessage(err)}`);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: billingKeys.heldBills });
    resetBill();
    setCart(bill.cart);
    setSelectedId(bill.cart.lines.at(-1)?.medicine.id ?? null);
    setDialog(null);
    if (cart.lines.length > 0) toast.info('The bill you were working on is now on hold');
    void refreshLines(bill.cart.lines);
  }

  async function discardHeld(bill: HeldBill) {
    try {
      await heldBills.remove(bill.id);
    } catch (err) {
      toast.error(`Could not discard the bill: ${errorMessage(err)}`);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: billingKeys.heldBills });
  }

  // ─── Shortcuts ────────────────────────────────────────────────────────────

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    // Open dialogs own the keyboard; a field that handled the key already said so.
    if (dialog || event.defaultPrevented) return;
    // A scan or typed letter while focus is elsewhere (a button, the page)
    // goes to the search box: focusing it during keydown lets the key land there.
    if (isTypedCharacter(event) && !isTextField(document.activeElement)) {
      searchRef.current?.focus();
      return;
    }
    const hasItems = cart.lines.length > 0;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };
    switch (event.key) {
      case 'F2':
        return run(focusSearch);
      case 'F3':
        return run(() => setDialog({ type: 'daySlip' }));
      case 'F4':
        return run(() => selectedId && focusQuantity(selectedId));
      case 'F6':
        return run(() => selectedId && setDialog({ type: 'discount', medicineId: selectedId }));
      case 'F7':
        return run(() => hasItems && setDialog({ type: 'discount', medicineId: null }));
      case 'F8':
        return run(openPay);
      case 'F9':
        return run(() => hasItems && setDialog({ type: 'hold' }));
      case 'F10':
        return run(() => setDialog({ type: 'held' }));
      case 'Escape':
        if (substitutesFor) return run(() => setSubstitutesFor(null));
        if (hasItems) return run(() => setDialog({ type: 'clear' }));
        return run(focusSearch);
    }
  });

  useEffect(() => {
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  const discountTarget = ((): DiscountTarget | null => {
    if (dialog?.type !== 'discount') return null;
    if (dialog.medicineId === null) {
      return {
        title: 'Whole bill, after line discounts',
        on: 'bill',
        base: totals.netBeforeBillDiscount,
        current: cart.discount,
        serverError: problem?.billDiscount,
      };
    }
    const line = cart.lines.find((l) => l.medicine.id === dialog.medicineId);
    if (!line) return null;
    return {
      title: `${line.medicine.name} × ${line.quantity}`,
      on: 'line',
      base: lineGross(line),
      current: line.discount,
      serverError: problem?.lines[line.medicine.id],
    };
  })();

  return (
    <div className="flex flex-col gap-3 md:grid md:h-[calc(100svh-5.5rem)] md:grid-cols-[minmax(0,1fr)_19rem] md:gap-4 lg:h-[calc(100svh-6.5rem)] xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-label="Bill" className="flex min-h-0 flex-col gap-3">
        <MedicineSearch
          inputRef={searchRef}
          onAdd={add}
          substitutesFor={substitutesFor}
          onSubstitutesFor={setSubstitutesFor}
          onIdleKey={onIdleKey}
        />

        {!offline.online && (
          <div
            role="status"
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3 text-sm',
              offline.catalogue
                ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
                : 'border-destructive/30 bg-destructive/10 text-destructive',
            )}
          >
            <CloudOffIcon className="mt-0.5 size-5 shrink-0" />
            {offline.catalogue ? (
              <p>
                <span className="font-medium">Offline.</span> Keep billing: sales are saved on this
                device and sync when the connection returns. Stock is as of{' '}
                {formatDateTime(offline.catalogue.generatedAt)}, less sales made here.
              </p>
            ) : (
              <p>
                <span className="font-medium">Offline, and no medicine list is saved here.</span>{' '}
                Sales can’t be made until the connection returns.
              </p>
            )}
          </div>
        )}

        {problem?.message && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <OctagonAlertIcon className="mt-0.5 size-5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">
                {problem.alreadySaved ? 'Already saved' : 'The sale was not saved'}
              </p>
              <p>{problem.message}</p>
              {problem.alreadySaved && (
                <Button variant="outline" size="sm" className="mt-2" onClick={resetBill}>
                  Start a new bill
                </Button>
              )}
            </div>
            {!problem.alreadySaved && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss"
                className="-m-2 text-destructive hover:text-destructive"
                onClick={() => setProblem((p) => p && { ...p, message: '' })}
              >
                <XIcon />
              </Button>
            )}
          </div>
        )}

        <div className="@container min-h-48 flex-1 overflow-y-auto rounded-lg border bg-card md:min-h-0">
          <CartList
            cart={cart}
            priced={totals.lines}
            selectedId={selectedId}
            problems={problem?.lines ?? {}}
            onSelect={setSelectedId}
            onQuantity={changeQuantity}
            onDiscount={(medicineId) => setDialog({ type: 'discount', medicineId })}
            onRemove={remove}
            onSubstitutes={(m) => {
              setSubstitutesFor(m);
              focusSearch();
            }}
            onDone={focusSearch}
          />
        </div>
        {cart.lines.length > 0 && <CartKeysHint />}
      </section>

      <aside aria-label="Totals" className="sticky bottom-0 z-10 -mx-1 md:static md:mx-0">
        <TotalsPanel
          totals={totals}
          lineCount={cart.lines.length}
          units={units}
          heldCount={held.data?.length ?? 0}
          billDiscountError={problem?.billDiscount ?? totals.billDiscountError}
          onBillDiscount={() => setDialog({ type: 'discount', medicineId: null })}
          onPay={openPay}
          onHold={() => setDialog({ type: 'hold' })}
          onHeldBills={() => setDialog({ type: 'held' })}
          onDaySlip={() => setDialog({ type: 'daySlip' })}
          onClear={() => setDialog({ type: 'clear' })}
        />
      </aside>

      {dialog?.type === 'pay' && (
        <PayDialog
          grandTotal={totals.grandTotal}
          pending={sell.isPending}
          error={payError}
          onConfirm={pay}
          onClose={() => setDialog(null)}
          onCloseAutoFocus={returnFocus}
        />
      )}
      {discountTarget && dialog?.type === 'discount' && (
        <DiscountDialog
          key={dialog.medicineId ?? 'bill'}
          target={discountTarget}
          isCashier={user.role === 'CASHIER'}
          onApply={(d) => applyDiscount(dialog.medicineId, d)}
          onClose={() => setDialog(null)}
          onCloseAutoFocus={returnFocus}
        />
      )}
      {dialog?.type === 'hold' && (
        <HoldDialog
          total={totals.grandTotal}
          onHold={(label) => void hold(label)}
          onClose={() => setDialog(null)}
          onCloseAutoFocus={returnFocus}
        />
      )}
      {dialog?.type === 'held' && (
        <HeldBillsDialog
          bills={held.data ?? []}
          loading={held.isPending}
          currentHasItems={cart.lines.length > 0}
          onResume={(bill) => void resume(bill)}
          onDiscard={(bill) => void discardHeld(bill)}
          onClose={() => setDialog(null)}
          onCloseAutoFocus={returnFocus}
        />
      )}
      {dialog?.type === 'clear' && (
        <ClearBillDialog
          onConfirm={() => {
            resetBill();
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
          onCloseAutoFocus={returnFocus}
        />
      )}
      {dialog?.type === 'daySlip' && (
        <DaySlipDialog onClose={() => setDialog(null)} onCloseAutoFocus={returnFocus} />
      )}
      {dialog?.type === 'done' && (
        <SaleCompleteDialog
          sale={dialog.sale}
          replayed={dialog.replayed}
          provisional={dialog.provisional}
          onNewSale={() => setDialog(null)}
          onCloseAutoFocus={returnFocus}
        />
      )}
    </div>
  );
}
