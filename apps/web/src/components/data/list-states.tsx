import { AlertTriangleIcon, RotateCwIcon, SearchXIcon, WifiOffIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '@/lib/api';

/** Placeholder rows shown while a table's first page loads. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y rounded-lg border" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-14 items-center gap-4 px-3">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={c === 0 ? 'h-4 flex-[2]' : 'h-4 flex-1'} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A failed load, with a retry. Says plainly when the server cannot be reached. */
export function ErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const offline = error instanceof ApiError && error.code === 'NETWORK_ERROR';
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-12 text-center"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        {offline ? (
          <WifiOffIcon className="size-6 text-destructive" />
        ) : (
          <AlertTriangleIcon className="size-6 text-destructive" />
        )}
      </div>
      <h2 className="text-lg font-semibold">
        {offline ? 'Cannot reach the server' : 'Could not load this list'}
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        {offline ? 'Check the internet connection, then try again.' : errorMessage(error)}
      </p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <RotateCwIcon className={retrying ? 'animate-spin' : undefined} />
          Try again
        </Button>
      )}
    </div>
  );
}

/** Shown when filters or a search match nothing (as opposed to an empty list). */
export function NoResults({ onClear }: { onClear?: () => void }) {
  return (
    <EmptyState
      icon={SearchXIcon}
      title="No matches"
      description="Nothing matches this search or filter."
      action={
        onClear && (
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        )
      }
    />
  );
}

type ListQuery<T> = {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  refetch: () => unknown;
};

/**
 * Picks the right state for a list: skeleton on first load, error with retry,
 * "no matches" when filtered, an empty state otherwise, else the list itself.
 * While a new page or filter loads the previous rows stay visible but dimmed.
 */
export function ListView<T extends { total: number; items: unknown[] }>({
  query,
  filtered,
  onClearFilters,
  onFirstPage,
  empty,
  columns,
  children,
}: {
  query: ListQuery<T>;
  /** Whether a search or filter is narrowing the list. */
  filtered: boolean;
  onClearFilters?: () => void;
  /** Rows can drop off the last page (e.g. after a deactivation); this goes back. */
  onFirstPage?: () => void;
  /** Shown when the unfiltered list has nothing in it. */
  empty: ReactNode;
  columns?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <TableSkeleton columns={columns} />;
  if (query.isError && !query.data) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const data = query.data!;
  if (data.total === 0) return filtered ? <NoResults onClear={onClearFilters} /> : empty;
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="This page is empty"
        description={`There are ${data.total} results, but not on this page.`}
        action={
          onFirstPage && (
            <Button variant="outline" onClick={onFirstPage}>
              Go to the first page
            </Button>
          )
        }
      />
    );
  }
  return (
    <div
      className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}
      aria-busy={query.isPlaceholderData}
    >
      {children(data)}
    </div>
  );
}
