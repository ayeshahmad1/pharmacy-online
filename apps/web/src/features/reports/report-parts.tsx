import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DownloadIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/data/list-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableHead } from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { downloadReport, reportKeys, type ReportQuery } from './reports-api';
import { RANGE_PRESETS, type DateRange, type RangePreset } from './report-range';

/** "35.74" → "35.74%", exactly as the API worked it out; no margin (nothing sold) is a dash. */
export function formatPercent(value: string | null): string {
  return value === null ? '—' : `${value}%`;
}

/** Preset ranges plus a custom from/to. Writes `range` or `from`/`to` into the URL. */
export function RangeFilter({
  range,
  onChange,
}: {
  range: DateRange & { preset: RangePreset | 'custom' };
  onChange: (changes: { range?: string; from?: string; to?: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <NativeSelect
        value={range.preset}
        onChange={(e) =>
          e.target.value === 'custom'
            ? onChange({ range: '', from: range.from, to: range.to })
            : onChange({ range: e.target.value, from: '', to: '' })
        }
        aria-label="Date range"
        className="w-full sm:w-44"
      >
        {RANGE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom range</option>
      </NativeSelect>
      {range.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="From"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && onChange({ from: e.target.value, to: range.to })}
            className="w-full sm:w-40"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="To"
            value={range.to}
            min={range.from}
            onChange={(e) => e.target.value && onChange({ from: range.from, to: e.target.value })}
            className="w-full sm:w-40"
          />
        </div>
      )}
    </div>
  );
}

/** Downloads the whole report (all pages) as CSV with the filters on screen. */
export function ExportButton({ path, query }: { path: string; query: ReportQuery }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      await downloadReport(path, query);
    } catch (err) {
      toast.error(`Export failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" onClick={() => void run()} disabled={busy}>
      <DownloadIcon className={busy ? 'animate-pulse' : undefined} /> Export CSV
    </Button>
  );
}

export type Tone = 'good' | 'bad' | 'warn';

/** A headline number with its label and an optional line of context. */
export function StatTile({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border bg-card p-4 shadow-sm', className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tracking-tight',
          tone === 'bad' && 'text-red-700 dark:text-red-400',
          tone === 'warn' && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

/** Loading and error states for reports that are not a single paged list. */
export function ReportState<T>({
  query,
  children,
}: {
  query: {
    data: T | undefined;
    error: unknown;
    isPending: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
    refetch: () => unknown;
  };
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (!query.data) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return (
    <div
      className={cn('space-y-4 transition-opacity', query.isPlaceholderData && 'opacity-60')}
      aria-busy={query.isPlaceholderData}
    >
      {children(query.data)}
    </div>
  );
}

/** A report section with a title, used for charts and tables. */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export const isLoss = (amount: string) => amount.startsWith('-');

/** Money cell, red when negative (a loss). */
export function MoneyCell({ amount, strong }: { amount: string; strong?: boolean }) {
  return (
    <TableCell
      className={cn(
        'text-right tabular-nums',
        strong && 'font-semibold',
        isLoss(amount) && 'text-red-700 dark:text-red-400',
      )}
    >
      {formatMoney(amount)}
    </TableCell>
  );
}

export const Num = ({ children, className }: { children: ReactNode; className?: string }) => (
  <TableCell className={cn('text-right tabular-nums', className)}>{children}</TableCell>
);
export const NumHead = ({ children, className }: { children: ReactNode; className?: string }) => (
  <TableHead className={cn('text-right', className)}>{children}</TableHead>
);

export function useReport<T>(
  name: string,
  query: ReportQuery,
  fetcher: (query: ReportQuery, signal?: AbortSignal) => Promise<T>,
) {
  return useQuery({
    queryKey: reportKeys.report(name, query),
    queryFn: ({ signal }) => fetcher(query, signal),
    placeholderData: keepPreviousData,
  });
}
