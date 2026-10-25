import {
  MAX_DAILY_REPORT_DAYS,
  MEDICINE_REPORT_SORTS,
  type MedicineReportSort,
  rangeDays,
} from '@pharmacy/shared';
import { ReceiptTextIcon } from 'lucide-react';
import { BarListChart, TrendChart } from '@/components/charts/charts';
import { chartPaisa } from '@/components/charts/chart-values';
import { ListToolbar } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { EmptyState } from '@/components/empty-state';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CategoryFilter } from '@/features/catalog/category-filter';
import { formatQuantity } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { reportsApi } from './reports-api';
import type { ReportParams } from './reports-page';
import {
  ExportButton,
  MoneyCell,
  Num,
  NumHead,
  RangeFilter,
  ReportState,
  Section,
  StatGrid,
  StatTile,
  formatPercent,
  isLoss,
  useReport,
} from './report-parts';
import { allowedGroupBy, defaultGroupBy, periodLabel } from './report-range';

const noSales = (
  <EmptyState
    icon={ReceiptTextIcon}
    title="No sales in this range"
    description="Pick another date range, or check back once sales have been made."
  />
);

// ─── Sales over time ────────────────────────────────────────────────────────

export function SalesView({ params }: { params: ReportParams }) {
  const { range, update } = params;
  const groupBy = allowedGroupBy(range, params.params.filters.groupBy || defaultGroupBy(range));
  const query = { from: range.from, to: range.to, groupBy };
  const report = useReport('sales', query, reportsApi.sales);
  const dailyAllowed = rangeDays(range.from, range.to) <= MAX_DAILY_REPORT_DAYS;

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="sales" query={query} />}>
        <RangeFilter range={range} onChange={update} />
        <NativeSelect
          value={groupBy}
          onChange={(e) => update({ groupBy: e.target.value })}
          aria-label="Group by"
          className="w-full sm:w-36"
        >
          <option value="day" disabled={!dailyAllowed}>
            By day
          </option>
          <option value="week">By week</option>
          <option value="month">By month</option>
        </NativeSelect>
      </ListToolbar>

      <ReportState query={report}>
        {(data) => (
          <>
            <StatGrid>
              <StatTile
                label="Revenue"
                value={formatMoney(data.totals.revenue)}
                sub={`${formatMoney(data.totals.netSales)} sales − ${formatMoney(data.totals.refunds)} refunds`}
              />
              <StatTile
                label="Gross profit"
                value={formatMoney(data.totals.grossProfit)}
                tone={isLoss(data.totals.grossProfit) ? 'bad' : undefined}
                sub={`Margin ${formatPercent(data.totals.marginPercent)}`}
              />
              <StatTile
                label="Sales"
                value={data.totals.saleCount.toLocaleString()}
                sub={`Average bill ${data.totals.averageBill ? formatMoney(data.totals.averageBill) : '—'}`}
              />
              <StatTile
                label="Discounts given"
                value={formatMoney(data.totals.discounts)}
                sub={`On ${formatMoney(data.totals.grossSales)} before discounts`}
              />
            </StatGrid>

            <Section title="Revenue and gross profit">
              <TrendChart
                data={data.periods.map((p) => ({
                  label: periodLabel(p.period, data.groupBy),
                  revenue: chartPaisa(p.revenue),
                  profit: chartPaisa(p.grossProfit),
                  saleCount: p.saleCount,
                }))}
              />
            </Section>

            <Section title={`By ${data.groupBy}`}>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <NumHead>Sales</NumHead>
                      <NumHead className="hidden md:table-cell">Net sales</NumHead>
                      <NumHead className="hidden md:table-cell">Refunds</NumHead>
                      <NumHead>Revenue</NumHead>
                      <NumHead className="hidden sm:table-cell">Cost</NumHead>
                      <NumHead>Profit</NumHead>
                      <NumHead className="hidden sm:table-cell">Margin</NumHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...data.periods].reverse().map((p) => (
                      <TableRow
                        key={p.period}
                        className={p.saleCount === 0 ? 'text-muted-foreground' : ''}
                      >
                        <TableCell className="whitespace-nowrap">
                          {periodLabel(p.period, data.groupBy)}
                        </TableCell>
                        <Num>{p.saleCount.toLocaleString()}</Num>
                        <Num className="hidden md:table-cell">{formatMoney(p.netSales)}</Num>
                        <Num className="hidden md:table-cell">{formatMoney(p.refunds)}</Num>
                        <MoneyCell amount={p.revenue} />
                        <Num className="hidden sm:table-cell">{formatMoney(p.cost)}</Num>
                        <MoneyCell amount={p.grossProfit} />
                        <Num className="hidden sm:table-cell">{formatPercent(p.marginPercent)}</Num>
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/50 font-semibold hover:bg-muted/50">
                      <TableCell>Total</TableCell>
                      <Num>{data.totals.saleCount.toLocaleString()}</Num>
                      <Num className="hidden md:table-cell">
                        {formatMoney(data.totals.netSales)}
                      </Num>
                      <Num className="hidden md:table-cell">{formatMoney(data.totals.refunds)}</Num>
                      <MoneyCell amount={data.totals.revenue} strong />
                      <Num className="hidden sm:table-cell">{formatMoney(data.totals.cost)}</Num>
                      <MoneyCell amount={data.totals.grossProfit} strong />
                      <Num className="hidden sm:table-cell">
                        {formatPercent(data.totals.marginPercent)}
                      </Num>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </Section>
          </>
        )}
      </ReportState>
    </div>
  );
}

// ─── Profit by medicine ─────────────────────────────────────────────────────

const SORT_LABELS: Record<MedicineReportSort, string> = {
  revenue: 'Highest revenue',
  profit: 'Highest profit',
  margin: 'Highest margin',
  units: 'Most units',
  name: 'Name',
};

export function MedicinesView({ params }: { params: ReportParams }) {
  const { range, update } = params;
  const { filters, q, page, pageSize } = params.params;
  const sort = (MEDICINE_REPORT_SORTS as readonly string[]).includes(filters.sort)
    ? filters.sort
    : 'revenue';
  const query = {
    from: range.from,
    to: range.to,
    sort,
    q: q || undefined,
    categoryId: filters.categoryId || undefined,
    page,
    pageSize,
  };
  const report = useReport('medicines', query, reportsApi.medicines);

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="medicines" query={query} />}>
        <RangeFilter range={range} onChange={update} />
        <SearchInput
          value={q}
          onChange={(value) => update({ q: value })}
          placeholder="Search medicines…"
          className="sm:w-56"
        />
        <CategoryFilter
          value={filters.categoryId}
          onChange={(categoryId) => update({ categoryId })}
        />
        <NativeSelect
          value={sort}
          onChange={(e) => update({ sort: e.target.value })}
          aria-label="Sort by"
          className="w-full sm:w-44"
        >
          {MEDICINE_REPORT_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </ListToolbar>

      {report.data && (
        <StatGrid>
          <StatTile label="Revenue" value={formatMoney(report.data.totals.revenue)} />
          <StatTile label="Cost" value={formatMoney(report.data.totals.cost)} />
          <StatTile
            label="Gross profit"
            value={formatMoney(report.data.totals.grossProfit)}
            tone={isLoss(report.data.totals.grossProfit) ? 'bad' : undefined}
          />
          <StatTile label="Margin" value={formatPercent(report.data.totals.marginPercent)} />
        </StatGrid>
      )}

      <ListView
        query={report}
        filtered={!!(q || filters.categoryId)}
        onClearFilters={() => update({ q: '', categoryId: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={noSales}
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medicine</TableHead>
                    <NumHead>Units</NumHead>
                    <NumHead>Revenue</NumHead>
                    <NumHead className="hidden sm:table-cell">Cost</NumHead>
                    <NumHead>Profit</NumHead>
                    <NumHead>Margin</NumHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((row) => (
                    <TableRow key={row.medicine.id}>
                      <TableCell>
                        <p className="font-medium">{row.medicine.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {[row.medicine.genericName, row.medicine.category]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </TableCell>
                      <Num>
                        {formatQuantity(row.netUnits, row.medicine.unit)}
                        {row.unitsReturned > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {row.unitsReturned} returned
                          </p>
                        )}
                      </Num>
                      <MoneyCell amount={row.revenue} />
                      <Num className="hidden sm:table-cell">{formatMoney(row.cost)}</Num>
                      <MoneyCell amount={row.grossProfit} strong />
                      <Num>{formatPercent(row.marginPercent)}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={(next) => update({ page: next })}
              onPageSizeChange={(size) => update({ pageSize: size })}
            />
          </div>
        )}
      </ListView>
    </div>
  );
}

// ─── Best sellers ───────────────────────────────────────────────────────────

const TOP = 10;

export function BestSellersView({ params }: { params: ReportParams }) {
  const { range, update } = params;
  const by = params.params.filters.sort === 'revenue' ? 'revenue' : 'units';
  const query = { from: range.from, to: range.to, sort: by, page: 1, pageSize: TOP };
  const report = useReport('medicines', query, reportsApi.medicines);

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="medicines" query={query} />}>
        <RangeFilter range={range} onChange={update} />
        <NativeSelect
          value={by}
          onChange={(e) => update({ sort: e.target.value })}
          aria-label="Rank by"
          className="w-full sm:w-44"
        >
          <option value="units">By units sold</option>
          <option value="revenue">By revenue</option>
        </NativeSelect>
      </ListToolbar>

      <ReportState query={report}>
        {(data) =>
          data.items.length === 0 ? (
            noSales
          ) : (
            <>
              <Section
                title={`Top ${Math.min(TOP, data.items.length)} by ${by === 'units' ? 'units sold' : 'revenue'}`}
                description="Net of returns."
              >
                <BarListChart
                  label="Best-selling medicines"
                  data={data.items.map((row) =>
                    by === 'units'
                      ? {
                          label: row.medicine.name,
                          value: row.netUnits,
                          display: formatQuantity(row.netUnits, row.medicine.unit),
                          detail: `Revenue ${formatMoney(row.revenue)}`,
                        }
                      : {
                          label: row.medicine.name,
                          value: chartPaisa(row.revenue),
                          display: formatMoney(row.revenue),
                          detail: formatQuantity(row.netUnits, row.medicine.unit),
                        },
                  )}
                />
              </Section>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Medicine</TableHead>
                      <NumHead>Units</NumHead>
                      <NumHead>Revenue</NumHead>
                      <NumHead className="hidden sm:table-cell">Profit</NumHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((row, i) => (
                      <TableRow key={row.medicine.id}>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {i + 1}
                        </TableCell>
                        <TableCell className="font-medium">{row.medicine.name}</TableCell>
                        <Num>{formatQuantity(row.netUnits, row.medicine.unit)}</Num>
                        <MoneyCell amount={row.revenue} />
                        <MoneyCell amount={row.grossProfit} />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )
        }
      </ReportState>
    </div>
  );
}

// ─── Cashiers ───────────────────────────────────────────────────────────────

export function CashiersView({ params }: { params: ReportParams }) {
  const { range, update } = params;
  const query = { from: range.from, to: range.to };
  const report = useReport('cashiers', query, reportsApi.cashiers);

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="cashiers" query={query} />}>
        <RangeFilter range={range} onChange={update} />
      </ListToolbar>

      <ReportState query={report}>
        {(data) =>
          data.cashiers.length === 0 ? (
            noSales
          ) : (
            <>
              <Section
                title="Revenue by cashier"
                description="Sales they rang up, less refunds against them."
              >
                <BarListChart
                  label="Revenue by cashier"
                  data={data.cashiers.map((c) => ({
                    label: c.cashier.fullName,
                    value: Math.max(chartPaisa(c.revenue), 0),
                    display: formatMoney(c.revenue),
                    detail: `${c.saleCount} sales`,
                  }))}
                />
              </Section>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cashier</TableHead>
                      <NumHead>Sales</NumHead>
                      <NumHead className="hidden md:table-cell">Average bill</NumHead>
                      <NumHead className="hidden lg:table-cell">Cash</NumHead>
                      <NumHead className="hidden lg:table-cell">Card</NumHead>
                      <NumHead className="hidden lg:table-cell">Wallet</NumHead>
                      <NumHead className="hidden sm:table-cell">Refunds</NumHead>
                      <NumHead>Revenue</NumHead>
                      <NumHead>Voided</NumHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      ...data.cashiers.map((c) => ({
                        key: c.cashier.id,
                        name: c.cashier.fullName,
                        row: c,
                      })),
                      { key: 'total', name: 'Total', row: data.totals },
                    ].map(({ key, name, row }) => (
                      <TableRow
                        key={key}
                        className={
                          key === 'total' ? 'bg-muted/50 font-semibold hover:bg-muted/50' : ''
                        }
                      >
                        <TableCell className="font-medium">{name}</TableCell>
                        <Num>{row.saleCount.toLocaleString()}</Num>
                        <Num className="hidden md:table-cell">
                          {row.averageBill ? formatMoney(row.averageBill) : '—'}
                        </Num>
                        <Num className="hidden lg:table-cell">{formatMoney(row.payments.CASH)}</Num>
                        <Num className="hidden lg:table-cell">{formatMoney(row.payments.CARD)}</Num>
                        <Num className="hidden lg:table-cell">
                          {formatMoney(row.payments.MOBILE_WALLET)}
                        </Num>
                        <Num className="hidden sm:table-cell">{formatMoney(row.refunds)}</Num>
                        <MoneyCell amount={row.revenue} strong />
                        <Num>
                          {row.voidedCount > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              {row.voidedCount} · {formatMoney(row.voidedTotal)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Num>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )
        }
      </ReportState>
    </div>
  );
}
