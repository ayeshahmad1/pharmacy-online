import type { SellableMedicineDto } from '@pharmacy/shared';
import {
  AlertTriangleIcon,
  MinusIcon,
  OctagonAlertIcon,
  PercentIcon,
  PlusIcon,
  ReplaceIcon,
  ShoppingCartIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { formatQuantity } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { isSellable } from './availability';
import { clampQuantity, stockShortfall, type Cart, type CartLine, type PricedLine } from './cart';

/** Focuses the quantity box of a cart line (F4). */
export function focusQuantity(medicineId: string) {
  const input = document.querySelector<HTMLInputElement>(
    `input[data-quantity-for="${CSS.escape(medicineId)}"]`,
  );
  input?.focus();
  input?.select();
}

type Props = {
  cart: Cart;
  priced: PricedLine[];
  selectedId: string | null;
  /** Problems the API reported per line, by medicine id. */
  problems: Record<string, string>;
  onSelect: (medicineId: string) => void;
  onQuantity: (medicineId: string, quantity: number) => void;
  onDiscount: (medicineId: string) => void;
  onRemove: (medicineId: string) => void;
  onSubstitutes: (medicine: SellableMedicineDto) => void;
  /** Sends focus back to the search box after editing a line. */
  onDone: () => void;
};

export function CartList({ cart, priced, selectedId, problems, ...handlers }: Props) {
  const selectedRow = useRef<HTMLLIElement>(null);
  // Keep the selected line in view when moving with the arrow keys or adding.
  useEffect(() => {
    // A block body: newer browsers return a promise from scrollIntoView, which
    // React would mistake for a cleanup function.
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, cart]);

  if (cart.lines.length === 0) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <ShoppingCartIcon className="size-10 opacity-40" />
        <div>
          <p className="font-medium text-foreground">The bill is empty</p>
          <p className="text-sm">Scan a barcode or search by medicine or salt name to add items.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sticky top-0 z-10 hidden grid-cols-[2rem_minmax(0,1fr)_6rem_9.5rem_7rem_7rem_2.5rem] items-center gap-2 border-b bg-muted/60 px-3 py-2 text-xs font-medium text-muted-foreground backdrop-blur @2xl:grid">
        <span>#</span>
        <span>Medicine</span>
        <span className="text-right">Price</span>
        <span className="text-center">Quantity</span>
        <span className="text-right">Discount</span>
        <span className="text-right">Total</span>
        <span className="sr-only">Remove</span>
      </div>
      <ul aria-label="Bill items" className="divide-y">
        {cart.lines.map((line, i) => (
          <CartRow
            key={line.medicine.id}
            ref={line.medicine.id === selectedId ? selectedRow : undefined}
            index={i}
            line={line}
            priced={priced[i]!}
            selected={line.medicine.id === selectedId}
            problem={problems[line.medicine.id]}
            {...handlers}
          />
        ))}
      </ul>
    </>
  );
}

function CartRow({
  ref,
  index,
  line,
  priced,
  selected,
  problem,
  onSelect,
  onQuantity,
  onDiscount,
  onRemove,
  onSubstitutes,
  onDone,
}: Omit<Props, 'cart' | 'priced' | 'selectedId' | 'problems'> & {
  ref?: Ref<HTMLLIElement>;
  index: number;
  line: CartLine;
  priced: PricedLine;
  selected: boolean;
  problem: string | undefined;
}) {
  const { medicine: m } = line;
  const id = m.id;
  const shortfall = stockShortfall(line);
  const discount = priced.lineDiscount + priced.billShare;
  const warning =
    problem ??
    priced.error ??
    (!isSellable(m)
      ? 'No sellable stock at last check'
      : shortfall > 0
        ? `Only ${formatQuantity(m.sellableQuantity, m.unit)} in stock at last check`
        : null);
  const severe = !!problem || !!priced.error;

  return (
    <li
      ref={ref}
      aria-current={selected || undefined}
      onClick={() => onSelect(id)}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-3 py-2.5 @2xl:grid-cols-[2rem_minmax(0,1fr)_6rem_9.5rem_7rem_7rem_2.5rem] @2xl:items-center @2xl:gap-2',
        selected && 'bg-accent/70 ring-2 ring-primary/40 ring-inset',
        severe && 'bg-red-50/70 dark:bg-red-950/25',
      )}
    >
      <span className="hidden text-sm text-muted-foreground tabular-nums @2xl:block">
        {index + 1}
      </span>

      <div className="min-w-0">
        <p className="truncate font-medium">{m.name}</p>
        <p className="truncate text-sm text-muted-foreground">
          {m.genericName ?? m.unit}
          <span className="@2xl:hidden">
            {' '}
            · {formatMoney(m.sellingPrice)}/{m.unit}
          </span>
        </p>
        {warning && (
          <p
            role={severe ? 'alert' : undefined}
            className={cn(
              'mt-1 flex items-start gap-1.5 text-sm',
              severe ? 'text-destructive' : 'text-amber-700 dark:text-amber-400',
            )}
          >
            {severe ? (
              <OctagonAlertIcon className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            )}
            <span>
              {warning}
              {(!isSellable(m) || (problem && /expired|out of stock/i.test(problem))) &&
                m.genericName && (
                  <button
                    type="button"
                    className="ml-2 inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSubstitutes(m);
                    }}
                  >
                    <ReplaceIcon className="size-3.5" /> Substitutes
                  </button>
                )}
            </span>
          </p>
        )}
      </div>

      <span className="hidden text-right text-sm tabular-nums @2xl:block">
        {formatMoney(m.sellingPrice)}
      </span>

      {/* In a narrow cart (phone, tablet, sidebar open) the controls wrap onto their own row. */}
      <div className="col-span-2 flex items-center justify-between gap-2 @2xl:contents">
        <QuantityControl
          medicineId={id}
          quantity={line.quantity}
          onChange={(q) => onQuantity(id, q)}
          onDone={onDone}
        />

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDiscount(id);
          }}
          className={cn(
            'flex h-10 items-center justify-end gap-1 rounded-md px-2 text-sm tabular-nums hover:bg-accent @2xl:justify-self-end',
            discount > 0n ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
          )}
          aria-label={`Discount for ${m.name}`}
        >
          {discount > 0n ? (
            `−${formatMoney(discount)}`
          ) : (
            <>
              <PercentIcon className="size-3.5" /> Add
            </>
          )}
        </button>

        <span className="ml-auto text-right font-semibold whitespace-nowrap tabular-nums @2xl:ml-0">
          {formatMoney(priced.total)}
        </span>

        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${m.name}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(id);
          }}
        >
          <Trash2Icon />
        </Button>
      </div>
    </li>
  );
}

function QuantityControl({
  medicineId,
  quantity,
  onChange,
  onDone,
}: {
  medicineId: string;
  quantity: number;
  onChange: (quantity: number) => void;
  onDone: () => void;
}) {
  // The typed text, while the box is being edited.
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n) && n > 0) onChange(clampQuantity(n));
    setDraft(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      onDone();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
      onDone();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setDraft(null);
      onChange(clampQuantity(quantity + (event.key === 'ArrowUp' ? 1 : -1)));
    }
  }

  return (
    <div
      className="flex items-center gap-1 @2xl:justify-self-center"
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        variant="outline"
        size="icon"
        aria-label="One less"
        disabled={quantity <= 1}
        onClick={() => onChange(clampQuantity(quantity - 1))}
      >
        <MinusIcon />
      </Button>
      <input
        data-quantity-for={medicineId}
        aria-label="Quantity"
        inputMode="numeric"
        autoComplete="off"
        value={draft ?? String(quantity)}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-10 w-14 rounded-md border border-input bg-background text-center text-base font-semibold tabular-nums outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <Button
        variant="outline"
        size="icon"
        aria-label="One more"
        onClick={() => onChange(clampQuantity(quantity + 1))}
      >
        <PlusIcon />
      </Button>
    </div>
  );
}

/** The shortcut legend under the cart on a keyboard-equipped screen. */
export function CartKeysHint() {
  return (
    <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground lg:flex">
      <span>
        <Kbd>↑</Kbd> <Kbd>↓</Kbd> select line
      </span>
      <span>
        <Kbd>+</Kbd> <Kbd>−</Kbd> quantity
      </span>
      <span>
        <Kbd>F4</Kbd> type quantity
      </span>
      <span>
        <Kbd>F6</Kbd> line discount
      </span>
      <span>
        <Kbd>Del</Kbd> remove line
      </span>
    </p>
  );
}
