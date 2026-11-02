import type { SaleDto } from '@pharmacy/shared';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ReceiptPrintArea } from '@/features/billing/receipt';
import { errorMessage, isUnreachable } from '@/lib/api';
import { salesApi } from './sales-api';

/** Why a reprint or a reprint search failed, in counter terms. */
export function reprintErrorMessage(err: unknown): string {
  return isUnreachable(err)
    ? 'Can’t reach the server. Reprinting needs the connection: old receipts are kept there.'
    : errorMessage(err);
}

/**
 * Reprints any sale's receipt: asks the server for it (which records the
 * reprint), then prints it marked as a reprint. Render `printArea` while the
 * hook is in use; nothing else on the screen may mount a print area at the
 * same time, or both would print.
 */
export function useReprint() {
  const [copy, setCopy] = useState<{ sale: SaleDto; reprintedAt: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (saleId: string) => salesApi.reprint(saleId),
    meta: { skipErrorToast: true },
    // A new object every time, so reprinting the same sale twice prints twice.
    onSuccess: (sale) => setCopy({ sale, reprintedAt: new Date().toISOString() }),
    onError: (err) => toast.error(reprintErrorMessage(err)),
  });

  useEffect(() => {
    if (!copy) return;
    // Let the print area render this copy first.
    const timer = setTimeout(() => window.print(), 50);
    return () => clearTimeout(timer);
  }, [copy]);

  return {
    reprint: (saleId: string) => mutation.mutate(saleId),
    /** The sale being fetched for a reprint, if any. */
    pendingId: mutation.isPending ? mutation.variables : null,
    /** The sale last reprinted, if any. */
    printed: copy?.sale ?? null,
    printArea: copy && <ReceiptPrintArea sale={copy.sale} reprintedAt={copy.reprintedAt} />,
  };
}
