import type { SellableMedicineDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  Loader2Icon,
  ReplaceIcon,
  ScanBarcodeIcon,
  SearchXIcon,
} from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ToneBadge } from '@/components/status-badges';
import { Kbd } from '@/components/ui/kbd';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { availabilityStatus, isSellable, nextExpiryStatus } from './availability';
import { billingApi, billingKeys } from './billing-api';
import { parseScan } from './cart';
import { errorBeep } from './feedback';
import { enterAction, shownResults } from './search-results';

/** Short enough to feel instant while typing, long enough to skip a request per key. */
const SEARCH_DEBOUNCE_MS = 120;
/** Results stay fresh briefly: stock changes with every sale. */
const SEARCH_STALE_MS = 5_000;

type Props = {
  inputRef: RefObject<HTMLInputElement | null>;
  /** Adds a sellable medicine to the cart. */
  onAdd: (medicine: SellableMedicineDto, quantity: number) => void;
  /** The out-of-stock medicine whose substitutes are listed, if any. */
  substitutesFor: SellableMedicineDto | null;
  onSubstitutesFor: (medicine: SellableMedicineDto | null) => void;
  /**
   * Keys pressed while the box is empty and no list is open (arrows, +/−,
   * Delete), for the cart to use. Returns true when handled.
   */
  onIdleKey: (event: KeyboardEvent<HTMLInputElement>) => boolean;
};

/**
 * The billing search box. Typing searches brand name, generic/salt name and
 * barcode as you type: this device's medicine list answers at once and the
 * server's answer replaces it when it comes (search-results.ts), so a far-away
 * or slow server doesn't slow the counter down. A scanner types the barcode
 * and Enter, which adds the match at once. A "qty*" prefix sets the quantity,
 * e.g. "3*" then a scan adds three.
 */
export function MedicineSearch({
  inputRef,
  onAdd,
  substitutesFor,
  onSubstitutesFor,
  onIdleKey,
}: Props) {
  const queryClient = useQueryClient();
  const listId = useId();
  const [text, setText] = useState('');
  // The highlighted row belongs to one list; a new list starts at its first row.
  const [cursor, setCursor] = useState({ list: '', index: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const { quantity, term } = parseScan(text);
  const debouncedTerm = useDebouncedValue(term, SEARCH_DEBOUNCE_MS);

  const search = useQuery({
    queryKey: billingKeys.search(debouncedTerm),
    queryFn: ({ signal }) => billingApi.search(debouncedTerm, signal),
    enabled: debouncedTerm.length > 0 && !substitutesFor,
    placeholderData: keepPreviousData,
    staleTime: SEARCH_STALE_MS,
    // Answered from this device's medicine list when offline, so never paused.
    networkMode: 'always',
  });
  // Not debounced: reading this device's list takes milliseconds.
  const local = useQuery({
    queryKey: billingKeys.localSearch(term),
    queryFn: () => billingApi.searchLocal(term),
    enabled: term.length > 0 && !substitutesFor,
    placeholderData: keepPreviousData,
    staleTime: SEARCH_STALE_MS,
    networkMode: 'always',
    // No list saved on this device yet: the server's answer is all there is.
    retry: false,
  });
  const shown = shownResults({
    term,
    server: { term: debouncedTerm, items: search.data, placeholder: search.isPlaceholderData },
    device: { items: local.data, placeholder: local.isPlaceholderData },
  });
  const substitutes = useQuery({
    queryKey: billingKeys.substitutes(substitutesFor?.id ?? ''),
    queryFn: ({ signal }) => billingApi.substitutes(substitutesFor!.id, signal),
    enabled: !!substitutesFor,
    staleTime: SEARCH_STALE_MS,
    networkMode: 'always',
  });

  const items: SellableMedicineDto[] = substitutesFor
    ? (substitutes.data?.substitutes ?? [])
    : shown.items;
  const listKey = substitutesFor ? `substitutes:${substitutesFor.id}` : `search:${term}`;
  const highlight = cursor.list === listKey ? Math.min(cursor.index, items.length - 1) : 0;
  const setHighlight = (index: number) => setCursor({ list: listKey, index });
  const open = !!substitutesFor || term.length > 0 || notice !== null;
  const active = items[highlight];

  function reset() {
    setText('');
    setNotice(null);
  }

  function choose(medicine: SellableMedicineDto, qty = quantity) {
    if (!isSellable(medicine)) {
      // Never sold (rules 2 and 3); offer what has the same salt instead.
      errorBeep();
      reset();
      onSubstitutesFor(medicine);
      return;
    }
    onAdd(medicine, qty);
    reset();
    onSubstitutesFor(null);
  }

  function notFound(message: string) {
    errorBeep();
    setNotice(message);
    // Selected, so the next scan replaces it.
    requestAnimationFrame(() => inputRef.current?.select());
  }

  async function submit() {
    if (substitutesFor) {
      if (active) choose(active);
      return;
    }
    if (!term) return;

    const action = enterAction(shown, active);
    if (action.kind === 'add') {
      choose(action.medicine);
      return;
    }
    if (action.kind === 'not-found') {
      notFound(`Nothing matches “${term}”`);
      return;
    }

    // Nothing on screen answers it yet: look the term up now and add an exact barcode match.
    setResolving(true);
    try {
      const results = await queryClient.fetchQuery({
        queryKey: billingKeys.search(term),
        queryFn: ({ signal }) => billingApi.search(term, signal),
        staleTime: SEARCH_STALE_MS,
        networkMode: 'always',
      });
      const exact =
        results.find((m) => m.barcodeMatch) ?? (results.length === 1 ? results[0] : undefined);
      if (exact) choose(exact);
      else if (results.length === 0) notFound(`Nothing matches “${term}”`);
      // Several name matches: leave the list open to pick from.
    } catch (err) {
      notFound(`Search failed: ${errorMessage(err)}`);
    } finally {
      setResolving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const listOpen = items.length > 0;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (listOpen) {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setHighlight((highlight + step + items.length) % items.length);
          return;
        }
        break;
      case 'Enter':
        event.preventDefault();
        void submit();
        return;
      case 'Escape':
        if (substitutesFor) {
          event.preventDefault();
          onSubstitutesFor(null);
          return;
        }
        if (text || notice) {
          event.preventDefault();
          reset();
          return;
        }
        break;
    }
    if (!text && !substitutesFor && onIdleKey(event)) event.preventDefault();
  }

  return (
    <div className="relative">
      <div className="relative">
        <ScanBarcodeIcon className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-label="Scan a barcode or search medicines"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNotice(null);
            if (substitutesFor) onSubstitutesFor(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Scan barcode or type medicine / salt name"
          className="h-14 w-full rounded-lg border-2 border-input bg-background pr-24 pl-11 text-lg shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-input/30"
        />
        <div className="pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-2">
          {(search.isFetching || resolving) && (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden />
          )}
          {quantity > 1 && (
            <span className="rounded bg-primary px-2 py-0.5 text-sm font-semibold text-primary-foreground">
              ×{quantity}
            </span>
          )}
          <Kbd className="hidden sm:inline-flex">F2</Kbd>
        </div>
      </div>

      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          {substitutesFor && (
            <SubstitutesHeader
              medicine={substitutesFor}
              onBack={() => {
                onSubstitutesFor(null);
                inputRef.current?.focus();
              }}
            />
          )}
          <ul
            id={listId}
            role="listbox"
            aria-label="Medicines"
            className="max-h-[min(60svh,28rem)] overflow-y-auto"
          >
            {items.map((m, i) => (
              <ResultRow
                key={m.id}
                id={`${listId}-${m.id}`}
                medicine={m}
                active={m === active}
                onHover={() => setHighlight(i)}
                onPick={() => {
                  choose(m);
                  inputRef.current?.focus();
                }}
              />
            ))}
          </ul>
          <ListMessage>
            {notice ? (
              <span className="flex items-center gap-2 text-destructive">
                <SearchXIcon className="size-4" /> {notice}
              </span>
            ) : substitutesFor ? (
              substitutes.isPending ? (
                'Looking for substitutes…'
              ) : substitutes.isError ? (
                <span className="text-destructive">{errorMessage(substitutes.error)}</span>
              ) : items.length === 0 ? (
                substitutesFor.genericName ? (
                  `No other ${substitutesFor.genericName} medicine is in stock.`
                ) : (
                  'No generic/salt name is recorded for this medicine, so no substitutes can be suggested.'
                )
              ) : null
            ) : items.length > 0 ? null : search.isError && debouncedTerm === term ? (
              <span className="text-destructive">{errorMessage(search.error)}</span>
            ) : shown.source === 'server' ? (
              `Nothing matches “${term}”`
            ) : (
              'Searching…'
            )}
          </ListMessage>
          {items.length > 0 && (
            <p className="hidden border-t px-3 py-1.5 text-xs text-muted-foreground sm:block">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> choose · <Kbd>Enter</Kbd> add · <Kbd>Esc</Kbd>{' '}
              {substitutesFor ? 'back' : 'clear'} · type <Kbd>3*</Kbd> before a scan for three
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ListMessage({ children }: { children: ReactNode }) {
  if (children === null || children === false) return null;
  return <p className="px-3 py-3 text-sm text-muted-foreground">{children}</p>;
}

function SubstitutesHeader({
  medicine,
  onBack,
}: {
  medicine: SellableMedicineDto;
  onBack: () => void;
}) {
  const status = availabilityStatus(medicine);
  return (
    <div className="flex items-start gap-3 border-b bg-amber-50/70 px-3 py-2.5 dark:bg-amber-950/25">
      <ReplaceIcon className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {medicine.name}: {status.label.toLowerCase()}
        </p>
        <p className="text-muted-foreground">
          {medicine.genericName
            ? `Substitutes with the same salt (${medicine.genericName}) in stock:`
            : 'No salt recorded.'}
        </p>
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onBack}
        className="flex h-9 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent"
      >
        <ArrowLeftIcon className="size-4" /> Back
      </button>
    </div>
  );
}

function ResultRow({
  id,
  medicine: m,
  active,
  onHover,
  onPick,
}: {
  id: string;
  medicine: SellableMedicineDto;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const sellable = isSellable(m);
  const expiry = nextExpiryStatus(m);
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      // Keep focus in the search box so typing and scanning carry on.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        'flex min-h-14 cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0',
        active && 'bg-accent',
        !sellable && 'text-muted-foreground',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-medium', sellable && 'text-foreground')}>{m.name}</p>
        <p className="truncate text-sm text-muted-foreground">
          {[m.genericName, m.barcode].filter(Boolean).join(' · ') || m.unit}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-semibold text-foreground tabular-nums">
          {formatMoney(m.sellingPrice)}
          <span className="font-normal text-muted-foreground">/{m.unit}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {sellable && expiry && expiry.tone !== 'ok' && <ToneBadge status={expiry} />}
          <ToneBadge status={availabilityStatus(m)} />
        </span>
      </div>
      {!sellable && (
        <span className="hidden shrink-0 text-xs font-medium text-primary sm:block">
          Enter: substitutes
        </span>
      )}
    </li>
  );
}
