import type {
  DeliveryBody,
  DeliveryDto,
  DeliverySummaryDto,
  ListDeliveriesQuery,
  Paginated,
  RejectDeliveryBody,
} from '@pharmacy/shared';
import type { QueryClient } from '@tanstack/react-query';
import { catalogKeys } from '@/features/catalog/catalog-api';
import { invalidateStock } from '@/features/inventory/inventory-api';
import { api } from '@/lib/api';

export const deliveriesKeys = {
  all: ['deliveries'] as const,
  list: (query: Partial<ListDeliveriesQuery>) => ['deliveries', 'list', query] as const,
  detail: (id: string) => ['deliveries', 'detail', id] as const,
  /** How many wait for approval: the badge staff see in the menu. */
  pendingCount: ['deliveries', 'pending-count'] as const,
};

type DeliveryResponse = { delivery: DeliveryDto };

export const deliveriesApi = {
  list: (query: Partial<ListDeliveriesQuery>, signal?: AbortSignal) =>
    api.get<Paginated<DeliverySummaryDto>>('/deliveries', query, signal),
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<DeliveryResponse>(`/deliveries/${id}`, undefined, signal)).delivery,
  create: async (body: DeliveryBody) =>
    (await api.post<DeliveryResponse>('/deliveries', body)).delivery,
  /** Replaces a pending delivery with a corrected version. */
  update: async (id: string, body: DeliveryBody) =>
    (await api.put<DeliveryResponse>(`/deliveries/${id}`, body)).delivery,
  approve: async (id: string) =>
    (await api.post<DeliveryResponse>(`/deliveries/${id}/approve`)).delivery,
  reject: async (id: string, body: RejectDeliveryBody) =>
    (await api.post<DeliveryResponse>(`/deliveries/${id}/reject`, body)).delivery,
};

/** A delivery changing state can add stock and medicines. */
export function invalidateAfterDelivery(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: deliveriesKeys.all }),
    client.invalidateQueries({ queryKey: catalogKeys.medicines }),
    invalidateStock(client),
  ]);
}
