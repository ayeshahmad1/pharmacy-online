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

export const billingKeys = {
  all: ['billing'] as const,
  search: (q: string) => ['billing', 'search', q] as const,
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
          )
        ).items,
      () => offlineBilling.search(q, SEARCH_LIMIT),
    ),
  /** Current price and stock of one medicine, to refresh a held or restored bill. */
  get: (medicineId: string, signal?: AbortSignal) =>
    orOffline(
      async () =>
        (
          await api.get<{ medicine: SellableMedicineDto }>(
            `/inventory/sellable/${medicineId}`,
            undefined,
            signal,
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
        ),
      () => offlineBilling.substitutes(medicineId),
    ),
  /** A replay (same idempotency key, same cart) returns the sale saved the first time. */
  createSale: (body: CreateSaleBody) =>
    api.post<{ sale: SaleDto; replayed: boolean }>('/sales', body),
  /** Today's sales (the server's business day), for the day-end slip. Online only. */
  daySales: (signal?: AbortSignal) => api.get<DaySalesDto>('/sales/day', undefined, signal),
};
