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

/**
 * A queued sale that gets no answer in time is tried again later under the
 * same idempotency key, so a hung request can't stall the queue.
 */
const SYNC_TIMEOUT_MS = 20_000;

/** What the sync engine sends through. */
export const syncApi: SyncApi = {
  createSale: (body) => api.post('/sales', body, { timeoutMs: SYNC_TIMEOUT_MS }),
  reportConflict: offlineApi.reportConflict,
  getConflict: offlineApi.getConflict,
};
