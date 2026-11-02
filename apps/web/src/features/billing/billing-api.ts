import type {
  CreateSaleBody,
  DaySalesDto,
  SaleDto,
  SellableMedicineDto,
  SubstitutesDto,
} from '@pharmacy/shared';
import { api, isUnreachable } from '@/lib/api';
import { connectivity } from '@/lib/connectivity';
import { offlineBilling } from '@/offline/catalogue-store';

/** Results shown under the search box; enough to pick from without scrolling. */
export const SEARCH_LIMIT = 8;

/**
 * How long the counter waits for the server before using this device's list
 * (lookups) or queueing the sale under its idempotency key (saving). Beyond
 * that the line is too slow to serve a customer at.
 */
const LOOKUP_TIMEOUT_MS = 4_000;
const SALE_TIMEOUT_MS = 12_000;

export const billingKeys = {
  all: ['billing'] as const,
  search: (q: string) => ['billing', 'search', q] as const,
  /** The same search answered from this device's medicine list, shown first. */
  localSearch: (q: string) => ['billing', 'local-search', q] as const,
  substitutes: (medicineId: string) => ['billing', 'substitutes', medicineId] as const,
  heldBills: ['billing', 'held-bills'] as const,
  daySales: ['billing', 'day-sales'] as const,
};

/**
 * Asks the server, or the medicine list saved on this device when the server
 * can't be reached, so lookups keep working offline.
 */
async function orOffline<T>(remote: () => Promise<T>, local: () => Promise<T>): Promise<T> {
  if (!connectivity.get().online) return local();
  try {
    return await remote();
  } catch (err) {
    if (isUnreachable(err)) return local();
    throw err;
  }
}

export const billingApi = {
  search: (q: string, signal?: AbortSignal) =>
    orOffline(
      async () =>
        (
          await api.get<{ items: SellableMedicineDto[] }>(
            '/inventory/sellable',
            { q, limit: SEARCH_LIMIT },
            signal,
            { timeoutMs: LOOKUP_TIMEOUT_MS },
          )
        ).items,
      () => offlineBilling.search(q, SEARCH_LIMIT),
    ),
  /** The same search from this device's medicine list only: instant, up to a few minutes old. */
  searchLocal: (q: string) => offlineBilling.search(q, SEARCH_LIMIT),
  /** Current price and stock of one medicine, to refresh a held or restored bill. */
  get: (medicineId: string, signal?: AbortSignal) =>
    orOffline(
      async () =>
        (
          await api.get<{ medicine: SellableMedicineDto }>(
            `/inventory/sellable/${medicineId}`,
            undefined,
            signal,
            { timeoutMs: LOOKUP_TIMEOUT_MS },
          )
        ).medicine,
      () => offlineBilling.get(medicineId),
    ),
  substitutes: (medicineId: string, signal?: AbortSignal) =>
    orOffline(
      () =>
        api.get<SubstitutesDto>(
          `/inventory/medicines/${medicineId}/substitutes`,
          undefined,
          signal,
          { timeoutMs: LOOKUP_TIMEOUT_MS },
        ),
      () => offlineBilling.substitutes(medicineId),
    ),
  /**
   * A replay (same idempotency key, same cart) returns the sale saved the
   * first time, so giving up on a slow answer and queueing is safe.
   */
  createSale: (body: CreateSaleBody) =>
    api.post<{ sale: SaleDto; replayed: boolean }>('/sales', body, {
      timeoutMs: SALE_TIMEOUT_MS,
    }),
  /** Today's sales (the server's business day), for the day-end slip. Online only. */
  daySales: (signal?: AbortSignal) => api.get<DaySalesDto>('/sales/day', undefined, signal),
};
