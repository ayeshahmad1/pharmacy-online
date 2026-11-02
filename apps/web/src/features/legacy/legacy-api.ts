import type {
  LegacyPurchaseDto,
  LegacyReturnDto,
  ListLegacyPurchasesQuery,
  ListLegacyReturnsQuery,
  Paginated,
} from '@pharmacy/shared';
import { api } from '@/lib/api';

// Read-only history from the old system (CLAUDE.md rule 15). It never changes,
// so it can stay cached for the session.
export const legacyKeys = {
  purchases: (query: Partial<ListLegacyPurchasesQuery>) => ['legacy', 'purchases', query] as const,
  returns: (query: Partial<ListLegacyReturnsQuery>) => ['legacy', 'returns', query] as const,
};

export const legacyApi = {
  purchases: (query: Partial<ListLegacyPurchasesQuery>, signal?: AbortSignal) =>
    api.get<Paginated<LegacyPurchaseDto>>('/legacy/purchases', query, signal),
  returns: (query: Partial<ListLegacyReturnsQuery>, signal?: AbortSignal) =>
    api.get<Paginated<LegacyReturnDto>>('/legacy/returns', query, signal),
};
