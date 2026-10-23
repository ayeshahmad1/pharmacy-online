import type {
  AdjustStockBody,
  BatchStockDto,
  ExpiredWriteOffDto,
  ExpiringStockDto,
  ExpiringStockQuery,
  ListMovementsQuery,
  ListStockQuery,
  LowStockQuery,
  MedicineStockDto,
  Paginated,
  ReceiveStockBody,
  StockAdjustmentDto,
  StockMovementDto,
  StockSummaryDto,
  WriteOffExpiredBody,
} from '@pharmacy/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const inventoryKeys = {
  all: ['inventory'] as const,
  stock: (query: object) => ['inventory', 'stock', query] as const,
  lowStock: (query: object) => ['inventory', 'low-stock', query] as const,
  expiring: (query: object) => ['inventory', 'expiring', query] as const,
  expired: (query: object) => ['inventory', 'expired', query] as const,
  medicine: (id: string, includeEmpty: boolean) =>
    ['inventory', 'medicine', id, { includeEmpty }] as const,
  movements: (query: object) => ['inventory', 'movements', query] as const,
};

type Query<T> = Partial<T>;

export const inventoryApi = {
  stock: (query: Query<ListStockQuery>, signal?: AbortSignal) =>
    api.get<Paginated<StockSummaryDto>>('/inventory/stock', query, signal),
  lowStock: (query: Query<LowStockQuery>, signal?: AbortSignal) =>
    api.get<Paginated<StockSummaryDto>>('/inventory/low-stock', query, signal),
  expiring: (query: Query<ExpiringStockQuery>, signal?: AbortSignal) =>
    api.get<ExpiringStockDto>('/inventory/expiring', query, signal),
  expired: (query: { page?: number; pageSize?: number }, signal?: AbortSignal) =>
    api.get<Paginated<BatchStockDto>>('/inventory/expired', query, signal),
  medicineStock: async (id: string, includeEmpty: boolean, signal?: AbortSignal) =>
    (
      await api.get<{ stock: MedicineStockDto }>(
        `/inventory/medicines/${id}/stock`,
        { includeEmpty: includeEmpty ? 'true' : undefined },
        signal,
      )
    ).stock,
  movements: (query: Query<ListMovementsQuery>, signal?: AbortSignal) =>
    api.get<Paginated<StockMovementDto>>('/inventory/movements', query, signal),
  receive: async (body: ReceiveStockBody) =>
    (await api.post<{ batches: BatchStockDto[] }>('/inventory/receipts', body)).batches,
  adjust: async (body: AdjustStockBody) =>
    (await api.post<{ adjustment: StockAdjustmentDto }>('/inventory/adjustments', body)).adjustment,
  writeOffExpired: async (body: WriteOffExpiredBody) =>
    (await api.post<{ writeOff: ExpiredWriteOffDto }>('/inventory/write-offs/expired', body))
      .writeOff,
};

/** Every stock change can move a medicine in or out of any stock list. */
export function invalidateStock(client: QueryClient) {
  return client.invalidateQueries({ queryKey: inventoryKeys.all });
}
