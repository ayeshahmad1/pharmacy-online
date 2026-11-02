import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import { CheckIcon, ChevronsUpDownIcon, Loader2Icon } from 'lucide-react';
import { useId, useState, type ReactNode, type Ref } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Type-to-search picker backed by an API list. Arrow keys move, Enter picks,
 * Escape closes. Typing after a pick clears it, so the field never shows a
 * name that is not the selected record.
 */
export function AsyncCombobox<T>({
  id,
  value,
  onChange,
  queryKey,
  search,
  getKey,
  getLabel,
  renderItem,
  placeholder,
  emptyText = 'No matches',
  emptyAction,
  inputRef,
  disabled,
  ...aria
}: {
  id?: string;
  value: T | null;
  onChange: (item: T | null) => void;
  queryKey: (term: string) => QueryKey;
  search: (term: string, signal: AbortSignal) => Promise<T[]>;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  renderItem?: (item: T) => ReactNode;
  placeholder?: string;
  emptyText?: string;
  /** Offered when nothing matches, e.g. to add what was typed as a new record. */
  emptyAction?: { label: (term: string) => string; onSelect: (term: string) => void };
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(term.trim(), 150);

  const results = useQuery({
    queryKey: queryKey(debounced),
    queryFn: ({ signal }) => search(debounced, signal),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const items = results.data ?? [];
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  function pick(item: T) {
    onChange(item);
    setTerm('');
    setOpen(false);
  }

  const shown = open || !value ? term : getLabel(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && items.length ? `${listId}-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={value && open ? getLabel(value) : placeholder}
            value={shown}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setTerm(e.target.value);
              setActive(0);
              setOpen(true);
              if (value) onChange(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
                setActive((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && open) {
                // Never let Enter in the picker submit the surrounding form.
                e.preventDefault();
                const item = items[activeIndex];
                if (item) pick(item);
              } else if (e.key === 'Escape' && open) {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === 'Tab') {
                setOpen(false);
              }
            }}
            className="pr-9"
            {...aria}
          />
          {results.isFetching && open ? (
            <Loader2Icon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : (
            <ChevronsUpDownIcon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="max-h-72 w-(--radix-popover-trigger-width) min-w-64 overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // Clicking back into the input should not close and reopen the list.
          const target = e.target as Node | null;
          if (target && document.getElementById(id ?? '')?.contains(target)) e.preventDefault();
        }}
      >
        <ul id={listId} role="listbox" aria-label={placeholder}>
          {results.isError && !items.length ? (
            <li className="px-3 py-6 text-center text-sm text-destructive">
              {errorMessage(results.error)}
            </li>
          ) : results.isPending ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</li>
          ) : items.length === 0 ? (
            <li className="space-y-2 px-3 py-6 text-center text-sm text-muted-foreground">
              <p>{emptyText}</p>
              {emptyAction && (
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  onClick={() => {
                    setOpen(false);
                    emptyAction.onSelect(term.trim());
                    setTerm('');
                  }}
                >
                  {emptyAction.label(term.trim())}
                </button>
              )}
            </li>
          ) : (
            items.map((item, index) => {
              const selected = value !== null && getKey(value) === getKey(item);
              return (
                <li
                  key={getKey(item)}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActive(index)}
                  // mousedown, not click: keep focus in the input until the pick lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(item);
                  }}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm',
                    index === activeIndex && 'bg-accent text-accent-foreground',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {renderItem ? renderItem(item) : getLabel(item)}
                  </div>
                  {selected && <CheckIcon className="size-4 shrink-0" />}
                </li>
              );
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
