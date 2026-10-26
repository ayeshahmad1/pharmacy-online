import type {
  CreateReturnBody,
  ListReturnsQuery,
  Paginated,
  RejectReturnBody,
  ReturnDto,
  ReturnSummaryDto,
  ReturnableQuery,
  ReturnableSaleDto,
} from '@pharmacy/shared';
import { api } from '@/lib/api';

export const returnsKeys = {
  all: ['returns'] as const,
  list: (query: Partial<ListReturnsQuery>) => ['returns', 'list', query] as const,
  detail: (id: string) => ['returns', 'detail', id] as const,
  returnable: (query: Partial<ReturnableQuery>) => ['returns', 'returnable', query] as const,
};

type ReturnResponse = { return: ReturnDto };

export const returnsApi = {
  list: (query: Partial<ListReturnsQuery>, signal?: AbortSignal) =>
    api.get<Paginated<ReturnSummaryDto>>('/returns', query, signal),
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<ReturnResponse>(`/returns/${id}`, undefined, signal)).return,
  /** A sale's lines with what can still come back, by sale id or receipt number. */
  returnable: (query: Partial<ReturnableQuery>, signal?: AbortSignal) =>
    api.get<ReturnableSaleDto>('/returns/returnable', query, signal),
  create: async (body: CreateReturnBody) =>
    (await api.post<ReturnResponse>('/returns', body)).return,
  approve: async (id: string) => (await api.post<ReturnResponse>(`/returns/${id}/approve`)).return,
  reject: async (id: string, body: RejectReturnBody) =>
    (await api.post<ReturnResponse>(`/returns/${id}/reject`, body)).return,
};
