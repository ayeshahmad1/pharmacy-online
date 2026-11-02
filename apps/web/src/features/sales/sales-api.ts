import type {
  ListSalesQuery,
  Paginated,
  ReprintMatchDto,
  SaleDto,
  SaleSummaryDto,
  SaleUserRef,
  VoidSaleBody,
} from '@pharmacy/shared';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateStock } from '@/features/inventory/inventory-api';
import { api } from '@/lib/api';

// Prefix keys: invalidating ['sales'] refreshes every list and detail.
export const salesKeys = {
  all: ['sales'] as const,
  list: (query: Partial<ListSalesQuery>) => ['sales', 'list', query] as const,
  detail: (id: string) => ['sales', 'detail', id] as const,
  cashiers: ['sales', 'cashiers'] as const,
  reprintSearch: (q: string) => ['sales', 'reprint', q] as const,
};

/** Reprints are asked for at the counter, so a slow line can't hang it (see lib/api.ts). */
const REPRINT_TIMEOUT_MS = 4_000;

export const salesApi = {
  list: (query: Partial<ListSalesQuery>, signal?: AbortSignal) =>
    api.get<Paginated<SaleSummaryDto>>('/sales', query, signal),
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<{ sale: SaleDto }>(`/sales/${id}`, undefined, signal)).sale,
  /** Everyone who has rung up a sale (ADMIN/PHARMACIST only). */
  cashiers: async (signal?: AbortSignal) =>
    (await api.get<{ cashiers: SaleUserRef[] }>('/sales/cashiers', undefined, signal)).cashiers,
  /** Any sale, whoever rang it up, by part of its receipt number or customer name. */
  reprintSearch: async (q: string, signal?: AbortSignal) =>
    (
      await api.get<{ sales: ReprintMatchDto[] }>('/sales/reprint', { q }, signal, {
        timeoutMs: REPRINT_TIMEOUT_MS,
      })
    ).sales,
  /** Any sale's receipt, for printing again; the server records the reprint. */
  reprint: async (id: string) =>
    (
      await api.post<{ sale: SaleDto }>(`/sales/${id}/reprint`, undefined, {
        timeoutMs: REPRINT_TIMEOUT_MS,
      })
    ).sale,
  void: async (id: string, body: VoidSaleBody) =>
    (await api.post<{ sale: SaleDto }>(`/sales/${id}/void`, body)).sale,
};

/**
 * After a void or a return: the sale's status, its returns, stock and the
 * reports built on them may all have changed.
 */
export async function invalidateAfterSaleChange(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: salesKeys.all }),
    client.invalidateQueries({ queryKey: ['returns'] }),
    client.invalidateQueries({ queryKey: ['reports'] }),
    invalidateStock(client),
  ]);
}
