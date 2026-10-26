import { ArrowLeftIcon, SearchXIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { ErrorState, TableSkeleton } from './list-states';

/** A detail page's first load. */
export function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-24 w-full" />
      <TableSkeleton rows={3} />
    </div>
  );
}

/**
 * A detail page that failed to load. A missing record (or a malformed id in
 * the address, or one this user may not see, which the API also answers
 * with 404) gets a way back to the list rather than a retry.
 */
export function DetailError({
  error,
  onRetry,
  retrying,
  missingTitle,
  missingDescription,
  backTo,
  backLabel,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  missingTitle: string;
  missingDescription: string;
  backTo: string;
  backLabel: string;
}) {
  const missing =
    error instanceof ApiError && (error.status === 404 || error.code === 'VALIDATION_ERROR');
  return missing ? (
    <EmptyState
      icon={SearchXIcon}
      title={missingTitle}
      description={missingDescription}
      action={
        <Button asChild variant="outline">
          <Link to={backTo}>{backLabel}</Link>
        </Button>
      }
    />
  ) : (
    <ErrorState error={error} onRetry={onRetry} retrying={retrying} />
  );
}

/** The "← Sales" link above a detail page's title. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
      <Link to={to}>
        <ArrowLeftIcon /> {children}
      </Link>
    </Button>
  );
}

/** Label/value pairs in a bordered grid, e.g. a record's key facts. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-medium break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
