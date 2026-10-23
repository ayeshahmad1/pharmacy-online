import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * List state (search, filters, page) lives in the URL, so a filtered page
 * survives a reload, can be bookmarked, and Back returns to it.
 */

export const PAGE_SIZES = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

export type ListParams<F extends string> = {
  page: number;
  pageSize: number;
  q: string;
  filters: Record<F, string>;
};

type Changes = Record<string, string | number | null | undefined>;

function positiveInt(value: string | null, fallback: number) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function readListParams<F extends string>(
  search: URLSearchParams,
  filterKeys: readonly F[],
  defaults: Partial<Record<F, string>> = {},
): ListParams<F> {
  const pageSize = positiveInt(search.get('pageSize'), DEFAULT_PAGE_SIZE);
  const filters = Object.fromEntries(
    filterKeys.map((key) => [key, search.get(key) ?? defaults[key] ?? '']),
  ) as Record<F, string>;
  return {
    page: positiveInt(search.get('page'), 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
    q: search.get('q') ?? '',
    filters,
  };
}

/**
 * Applies changes to the search params. Any change other than the page itself
 * goes back to page 1, since the old page may not exist under the new filter.
 * Values equal to their default are dropped to keep URLs short.
 */
export function applyListChanges(
  search: URLSearchParams,
  changes: Changes,
  defaults: Record<string, string> = {},
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const [key, raw] of Object.entries(changes)) {
    const value = raw === null || raw === undefined ? '' : String(raw);
    const isDefault =
      value === '' ||
      value === defaults[key] ||
      (key === 'page' && value === '1') ||
      (key === 'pageSize' && value === String(DEFAULT_PAGE_SIZE));
    if (isDefault) next.delete(key);
    else next.set(key, value);
  }
  if (!('page' in changes)) next.delete('page');
  return next;
}

export function useListParams<F extends string>(
  filterKeys: readonly F[],
  defaults: Partial<Record<F, string>> = {},
) {
  const [search, setSearch] = useSearchParams();
  // Callers pass inline arrays/objects; key the memo on their contents.
  const keysKey = filterKeys.join(',');
  const defaultsKey = JSON.stringify(defaults);

  const params = useMemo(
    () =>
      readListParams(search, keysKey.split(',') as F[], JSON.parse(defaultsKey) as typeof defaults),
    [search, keysKey, defaultsKey],
  );

  const update = useCallback(
    (changes: Changes, options?: { replace?: boolean }) => {
      setSearch(
        (current) =>
          applyListChanges(current, changes, JSON.parse(defaultsKey) as Record<string, string>),
        { replace: options?.replace },
      );
    },
    [setSearch, defaultsKey],
  );

  return { params, update };
}
