import { PageIntro } from '@/components/data/filters';
import { useListParams } from '@/lib/list-params';
import { cn } from '@/lib/utils';
import { CashClosingView } from './cash-closing-view';
import { BestSellersView, CashiersView, MedicinesView, SalesView } from './sales-views';
import { DeadStockView, ExpiryView, LowStockView, SuppliersView } from './stock-views';
import { resolveRange } from './report-range';

const VIEWS = [
  { id: 'sales', label: 'Sales' },
  { id: 'medicines', label: 'Profit by medicine' },
  { id: 'best-sellers', label: 'Best sellers' },
  { id: 'cashiers', label: 'Cashiers' },
  { id: 'cash-closing', label: 'Cash closing' },
  { id: 'low-stock', label: 'Low stock' },
  { id: 'expiry', label: 'Expiry' },
  { id: 'dead-stock', label: 'Dead stock' },
  { id: 'suppliers', label: 'Supplier purchases' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

const FILTERS = [
  'view',
  'range',
  'from',
  'to',
  'groupBy',
  'sort',
  'categoryId',
  'days',
  'supplierId',
  'date',
] as const;
const DEFAULTS = { view: 'sales', range: '30d' };

function useReportParams() {
  return useListParams(FILTERS, DEFAULTS);
}

export type ReportParams = ReturnType<typeof useReportParams> & {
  range: ReturnType<typeof resolveRange>;
};

export function ReportsPage() {
  const list = useReportParams();
  const view = (
    VIEWS.some((v) => v.id === list.params.filters.view) ? list.params.filters.view : 'sales'
  ) as ViewId;
  const params: ReportParams = { ...list, range: resolveRange(list.params.filters) };

  function switchView(next: ViewId) {
    // The date range carries over; each view's own filters start clean.
    list.update({
      view: next,
      q: '',
      groupBy: '',
      sort: '',
      categoryId: '',
      days: '',
      supplierId: '',
      date: '',
      pageSize: '',
    });
  }

  return (
    <div className="space-y-4">
      <PageIntro description="Sales count on the day they were rung up; voided sales are left out, and a refund comes off the day of the sale it was returned against. Cash closing follows the drawer instead." />

      <div
        role="tablist"
        aria-label="Reports"
        className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => switchView(v.id)}
            className={cn(
              'flex h-10 shrink-0 items-center rounded-md px-4 text-sm font-medium whitespace-nowrap transition-colors',
              view === v.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {view === 'sales' && <SalesView params={params} />}
        {view === 'medicines' && <MedicinesView params={params} />}
        {view === 'best-sellers' && <BestSellersView params={params} />}
        {view === 'cashiers' && <CashiersView params={params} />}
        {view === 'cash-closing' && <CashClosingView params={params} />}
        {view === 'low-stock' && <LowStockView params={params} />}
        {view === 'expiry' && <ExpiryView params={params} />}
        {view === 'dead-stock' && <DeadStockView params={params} />}
        {view === 'suppliers' && <SuppliersView params={params} />}
      </div>
    </div>
  );
}
