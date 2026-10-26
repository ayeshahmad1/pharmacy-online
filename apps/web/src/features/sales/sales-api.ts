import type {
  ListSalesQuery,
  Paginated,
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
};

export const salesApi = {
  list: (query: Partial<ListSalesQuery>, signal?: AbortSignal) =>
    api.get<Paginated<SaleSummaryDto>>('/sales', query, signal),
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<{ sale: SaleDto }>(`/sales/${id}`, undefined, signal)).sale,
  /** Everyone who has rung up a sale (ADMIN/PHARMACIST only). */
  cashiers: async (signal?: AbortSignal) =>
    (await api.get<{ cashiers: SaleUserRef[] }>('/sales/cashiers', undefined, signal)).cashiers,
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
