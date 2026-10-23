import { useQuery } from '@tanstack/react-query';
import { catalogKeys, categoriesApi } from './catalog-api';

/**
 * Active categories for pickers and filters. A pharmacy has a few dozen at
 * most, so one page of 100 covers them; the API caps pages at 100.
 */
export function useActiveCategories() {
  return useQuery({
    queryKey: [...catalogKeys.categories, 'options'],
    queryFn: ({ signal }) => categoriesApi.list({ status: 'ACTIVE', pageSize: 100 }, signal),
    staleTime: 5 * 60_000,
    select: (page) => page.items,
  });
}
