import type {
  CreateSaleBody,
  DismissOfflineConflictBody,
  ListOfflineConflictsQuery,
  OfflineSaleConflictDto,
  Paginated,
  RetryOfflineConflictBody,
} from '@pharmacy/shared';
import { api } from '@/lib/api';
import type { SyncError } from './sale-queue';
import type { SyncApi } from './sync';

export const offlineKeys = {
  all: ['offline-sales'] as const,
  conflicts: (query: Partial<ListOfflineConflictsQuery>) =>
    ['offline-sales', 'conflicts', query] as const,
};

type ConflictResponse = { conflict: OfflineSaleConflictDto };

export const offlineApi = {
  listConflicts: (query: Partial<ListOfflineConflictsQuery>, signal?: AbortSignal) =>
    api.get<Paginated<OfflineSaleConflictDto>>('/offline-sales/conflicts', query, signal),
  getConflict: async (id: string) =>
    (await api.get<ConflictResponse>(`/offline-sales/conflicts/${id}`)).conflict,
  reportConflict: async (sale: CreateSaleBody, error: SyncError) =>
    (await api.post<ConflictResponse>('/offline-sales/conflicts', { sale, error })).conflict,
  retry: async (id: string, body: RetryOfflineConflictBody) =>
    (await api.post<ConflictResponse>(`/offline-sales/conflicts/${id}/retry`, body)).conflict,
  dismiss: async (id: string, body: DismissOfflineConflictBody) =>
    (await api.post<ConflictResponse>(`/offline-sales/conflicts/${id}/dismiss`, body)).conflict,
};

/** What the sync engine sends through. */
export const syncApi: SyncApi = {
  createSale: (body) => api.post('/sales', body),
  reportConflict: offlineApi.reportConflict,
  getConflict: offlineApi.getConflict,
};
