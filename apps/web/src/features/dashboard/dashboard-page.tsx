import type { PaymentMethod } from '@pharmacy/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownRightIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  BellIcon,
  CalendarClockIcon,
  CalendarXIcon,
  CloudOffIcon,
  PackageMinusIcon,
  PackageXIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { BarListChart, TrendChart } from '@/components/charts/charts';
import { chartPaisa } from '@/components/charts/chart-values';
import { Button } from '@/components/ui/button';
import { reportKeys, reportsApi } from '@/features/reports/reports-api';
import {
  ReportState,
  Section,
  StatTile,
  formatPercent,
  isLoss,
} from '@/features/reports/report-parts';
import { periodLabel } from '@/features/reports/report-range';
import { formatDate } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { percentChange, type Change } from './dashboard-calc';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  MOBILE_WALLET: 'Mobile wallet',
};

function ChangeNote({ change, against }: { change: Change | null; against: string }) {
  if (!change) return <>No sales {against} to compare</>;
  const Icon = change.direction === 'down' ? ArrowDownRightIcon : ArrowUpRightIcon;
  return (
    <span className="inline-flex items-center gap-1">
      {change.direction !== 'flat' && (
        <Icon
          aria-hidden
          className={cn(
            'size-4',
            change.direction === 'up'
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-red-700 dark:text-red-400',
          )}
        />
      )}
      {change.text} vs {against}
    </span>
  );
}

/** A count that needs someone's attention, linking to where it is dealt with. */
function AttentionCard({
  icon: Icon,
  label,
  count,
  to,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  to: string;
  tone: 'danger' | 'warning';
}) {
  const active = count > 0;
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent',
        !active && 'text-muted-foreground',
      )}
    >
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full',
          !active && 'bg-muted',
          active &&
            tone === 'danger' &&
            'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
          active &&
            tone === 'warning' &&
            'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
        )}
      >
        <Icon className="size-5" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className={cn('text-2xl font-semibold tabular-nums', active && 'text-foreground')}>
          {count}
        </p>
        <p className="truncate text-sm">{label}</p>
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const dashboard = useQuery({
    queryKey: reportKeys.dashboard,
    queryFn: ({ signal }) => reportsApi.dashboard(signal),
    refetchInterval: 60_000,
  });

  return (
    <ReportState query={{ ...dashboard, isPlaceholderData: false }}>
      {(d) => (
        <>
          <p className="text-sm text-muted-foreground">
            {formatDate(d.businessDate)} · revenue is sales less refunds; profit is revenue less the
            cost of what sold.
          </p>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Revenue today"
              value={formatMoney(d.today.revenue)}
              sub={
                <ChangeNote
                  change={percentChange(d.today.revenue, d.yesterday.revenue)}
                  against="yesterday"
                />
              }
            />
            <StatTile
              label="Gross profit today"
              value={formatMoney(d.today.grossProfit)}
              tone={isLoss(d.today.grossProfit) ? 'bad' : undefined}
              sub={`Margin ${formatPercent(d.today.marginPercent)}`}
            />
            <StatTile
              label="Sales today"
              value={d.today.saleCount.toLocaleString()}
              sub={`Average bill ${d.today.averageBill ? formatMoney(d.today.averageBill) : '—'}`}
            />
            <StatTile
              label="This month"
              value={formatMoney(d.monthToDate.revenue)}
              sub={`Profit ${formatMoney(d.monthToDate.grossProfit)} · ${formatPercent(d.monthToDate.marginPercent)}`}
            />
          </div>

          <Section
            title="Last 30 days"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="/reports?view=sales">
                  Sales report <ArrowRightIcon />
                </Link>
              </Button>
            }
          >
            <TrendChart
              data={d.trend.map((p) => ({
                label: periodLabel(p.period, 'day'),
                revenue: chartPaisa(p.revenue),
                profit: chartPaisa(p.grossProfit),
                saleCount: p.saleCount,
              }))}
            />
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="Best sellers"
              description="By revenue, last 30 days"
              actions={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/reports?view=best-sellers&sort=revenue">
                    All <ArrowRightIcon />
                  </Link>
                </Button>
              }
            >
              {d.bestSellers.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No sales yet.</p>
              ) : (
                <BarListChart
                  label="Best sellers by revenue"
                  data={d.bestSellers.map((b) => ({
                    label: b.medicine.name,
                    value: Math.max(chartPaisa(b.revenue), 0),
                    display: formatMoney(b.revenue),
                    detail: `${b.netUnits.toLocaleString()} ${b.medicine.unit} · margin ${formatPercent(b.marginPercent)}`,
                  }))}
                />
              )}
            </Section>
            <Section
              title="Payments today"
              actions={
                <Button asChild variant="ghost" size="sm">
                  <Link to="/reports?view=cash-closing">
                    Cash closing <ArrowRightIcon />
                  </Link>
                </Button>
              }
            >
              <BarListChart
                label="Payments today by method"
                data={d.paymentsToday.map((p) => ({
                  label: METHOD_LABELS[p.method],
                  value: chartPaisa(p.amount),
                  display: formatMoney(p.amount),
                  detail: `${p.count} sale${p.count === 1 ? '' : 's'}`,
                }))}
              />
            </Section>
          </div>

          <div>
            <h3 className="mb-3 font-semibold">Needs attention</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <AttentionCard
                icon={PackageXIcon}
                label="Out of stock"
                count={d.stock.outOfStock}
                to="/inventory?view=low"
                tone="danger"
              />
              <AttentionCard
                icon={PackageMinusIcon}
                label="Low stock"
                count={d.stock.lowStock}
                to="/reports?view=low-stock"
                tone="warning"
              />
              <AttentionCard
                icon={CalendarClockIcon}
                label={`Expiring within ${d.stock.expiringDays} days`}
                count={d.stock.expiringSoon}
                to={`/reports?view=expiry&days=${d.stock.expiringDays}`}
                tone="warning"
              />
              <AttentionCard
                icon={CalendarXIcon}
                label="Expired batches on the shelf"
                count={d.stock.expiredOnShelf}
                to="/inventory?view=expired"
                tone="danger"
              />
              <AttentionCard
                icon={BellIcon}
                label="Unread alerts"
                count={d.unreadAlerts}
                to="/alerts?state=unread"
                tone="warning"
              />
              <AttentionCard
                icon={Undo2Icon}
                label="Returns awaiting approval"
                count={d.pendingReturns}
                to="/returns"
                tone="warning"
              />
              <AttentionCard
                icon={CloudOffIcon}
                label="Offline sales to review"
                count={d.openOfflineConflicts}
                to="/offline-sales"
                tone="danger"
              />
            </div>
          </div>
        </>
      )}
    </ReportState>
  );
}
