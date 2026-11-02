import { useQuery } from '@tanstack/react-query';
import { LoaderCircleIcon, PrinterIcon, SearchIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
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
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { reprintErrorMessage, useReprint } from './reprint';
import { salesApi, salesKeys } from './sales-api';
import { SaleStatusBadge } from './status-badges';

const MIN_TERM = 3;

/**
 * Finds any old sale, whoever rang it up, by receipt number or customer name
 * and prints its receipt again, marked as a reprint. Type, ↑/↓ to choose,
 * Enter prints; Esc closes. Stays open after printing, for another copy.
 */
export function ReprintDialog({
  onClose,
  onCloseAutoFocus,
}: {
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [term, setTerm] = useState('');
  const [index, setIndex] = useState(0);
  const q = useDebouncedValue(term.trim(), 200);
  const searchable = q.length >= MIN_TERM;
  const matches = useQuery({
    queryKey: salesKeys.reprintSearch(q),
    queryFn: ({ signal }) => salesApi.reprintSearch(q, signal),
    enabled: searchable,
    // At the counter: an unreachable server should say so at once, not after retries.
    retry: false,
    staleTime: 0,
  });
  const { reprint, pendingId, printed, printArea } = useReprint();

  const results = searchable ? (matches.data ?? []) : [];
  const active = Math.min(index, results.length - 1);

  function onKeyDown(event: KeyboardEvent) {
    if (results.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setIndex((active + step + results.length) % results.length);
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      if (!pendingId) reprint(results[active]!.id);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl" onKeyDown={onKeyDown} onCloseAutoFocus={onCloseAutoFocus}>
        {printArea}
        <DialogHeader>
          <DialogTitle>Reprint a receipt</DialogTitle>
          <DialogDescription>
            Any sale, whoever rang it up. Search by receipt number or customer name. The copy is
            marked as a reprint, and the reprint is recorded.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            aria-label="Receipt number or customer name"
            placeholder="e.g. 0042, S-20261102-0042 or Ali"
            className="h-12 pl-9 text-base"
            maxLength={100}
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setIndex(0);
            }}
          />
        </div>

        <div className="min-h-40">
          {!searchable ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Type at least {MIN_TERM} characters of the receipt number or the customer’s name.
            </p>
          ) : matches.isError ? (
            <p role="alert" className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
              {reprintErrorMessage(matches.error)}
            </p>
          ) : matches.isPending ? (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" /> Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No sale matches “{q}”.</p>
          ) : (
            <ul className="grid max-h-[50svh] gap-1 overflow-y-auto" aria-label="Matching sales">
              {results.map((sale, i) => (
                <li key={sale.id}>
                  <button
                    type="button"
                    aria-current={i === active}
                    disabled={!!pendingId}
                    onClick={() => reprint(sale.id)}
                    onMouseEnter={() => setIndex(i)}
                    className={cn(
                      'flex min-h-14 w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm',
                      i === active ? 'border-primary bg-primary/5' : 'border-transparent',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-medium">{sale.receiptNumber}</span>
                        {sale.status !== 'COMPLETED' && <SaleStatusBadge status={sale.status} />}
                      </p>
                      <p className="truncate text-muted-foreground">
                        {[formatDateTime(sale.soldAt), sale.customerName, sale.cashier.fullName]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <span className="font-medium whitespace-nowrap tabular-nums">
                      {formatMoney(sale.grandTotal)}
                    </span>
                    {pendingId === sale.id ? (
                      <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <PrinterIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <p role="status" className="text-sm text-muted-foreground">
            {printed && `Reprinted ${printed.receiptNumber}`}
          </p>
          <Button variant="outline" size="lg" onClick={onClose}>
            Close <Kbd>Esc</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
