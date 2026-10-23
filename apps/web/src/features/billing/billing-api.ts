import type {
  CreateSaleBody,
  SaleDto,
  SellableMedicineDto,
  SubstitutesDto,
} from '@pharmacy/shared';
import { api } from '@/lib/api';

/** Results shown under the search box; enough to pick from without scrolling. */
export const SEARCH_LIMIT = 8;

export const billingKeys = {
  all: ['billing'] as const,
  search: (q: string) => ['billing', 'search', q] as const,
  substitutes: (medicineId: string) => ['billing', 'substitutes', medicineId] as const,
  heldBills: ['billing', 'held-bills'] as const,
};

export const billingApi = {
  search: async (q: string, signal?: AbortSignal) =>
    (
      await api.get<{ items: SellableMedicineDto[] }>(
        '/inventory/sellable',
        { q, limit: SEARCH_LIMIT },
        signal,
      )
    ).items,
  /** Current price and stock of one medicine, to refresh a held or restored bill. */
  get: async (medicineId: string, signal?: AbortSignal) =>
    (
      await api.get<{ medicine: SellableMedicineDto }>(
        `/inventory/sellable/${medicineId}`,
        undefined,
        signal,
      )
    ).medicine,
  substitutes: (medicineId: string, signal?: AbortSignal) =>
    api.get<SubstitutesDto>(`/inventory/medicines/${medicineId}/substitutes`, undefined, signal),
  /** A replay (same idempotency key, same cart) returns the sale saved the first time. */
  createSale: (body: CreateSaleBody) =>
    api.post<{ sale: SaleDto; replayed: boolean }>('/sales', body),
};
