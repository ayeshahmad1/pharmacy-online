import type { CreateSaleBody, SaleDto } from '@pharmacy/shared';
import { newQueuedSale, type QueueStore, type QueuedSale } from './sale-queue';

let seq = 0;

/** A queue store in memory, standing in for IndexedDB. */
export function memoryStore(initial: QueuedSale[] = []): QueueStore & {
  rows: Map<string, QueuedSale>;
} {
  const rows = new Map(initial.map((s) => [s.idempotencyKey, structuredClone(s)]));
  return {
    rows,
    list: () =>
      Promise.resolve(
        [...rows.values()]
          .map((s) => structuredClone(s))
          .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
      ),
    put: (sale) => {
      rows.set(sale.idempotencyKey, structuredClone(sale));
      return Promise.resolve();
    },
    remove: (key) => {
      rows.delete(key);
      return Promise.resolve();
    },
  };
}

/** A queued offline sale; `minutesAgo` orders them. */
export function queued(
  opts: {
    userId?: string;
    minutesAgo?: number;
    items?: CreateSaleBody['items'];
    now?: Date;
  } & Partial<QueuedSale> = {},
): QueuedSale {
  seq += 1;
  const now = opts.now ?? new Date('2026-10-24T07:00:00.000Z');
  const at = new Date(now.getTime() - (opts.minutesAgo ?? 0) * 60_000);
  const key = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const body: CreateSaleBody = {
    idempotencyKey: key,
    items: opts.items ?? [{ medicineId: 'm-1', quantity: 1 }],
    payments: [{ method: 'CASH', amount: '10.00' }],
    offline: { soldAt: at.toISOString(), expectedTotal: '10.00' },
  };
  const { userId = 'u-1', minutesAgo: _m, items: _i, now: _n, ...overrides } = opts;
  return {
    ...newQueuedSale({
      body,
      receipt: { receiptNumber: `OFF-${seq}` } as SaleDto,
      user: { id: userId, fullName: 'Counter One' },
      now: at,
    }),
    ...overrides,
  };
}

/** Just enough of a saved sale for the sync engine. */
export const savedSale = (receiptNumber: string) =>
  ({ id: `sale-${receiptNumber}`, receiptNumber }) as SaleDto;
