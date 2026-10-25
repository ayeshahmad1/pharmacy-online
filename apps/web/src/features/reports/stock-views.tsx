import type { ExpiryBucket } from '@pharmacy/shared';
import { ArrowLeftIcon, CircleCheckIcon, PackageSearchIcon, TruckIcon } from 'lucide-react';
import { Link } from 'react-router';
import { ListToolbar } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { EmptyState } from '@/components/empty-state';
import { ToneBadge, toneRowClass } from '@/components/status-badges';
import { Button } from '@/components/ui/button';
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
import { formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { expiryStatus, stockStatus } from '@/lib/stock-status';
import { reportsApi } from './reports-api';
import type { ReportParams } from './reports-page';
import {
  ExportButton,
  Num,
  NumHead,
  RangeFilter,
  ReportState,
  Section,
  StatGrid,
  StatTile,
  useReport,
} from './report-parts';

const positiveInt = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function DaysSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: number;
  options: number[];
  label: (days: number) => string;
  onChange: (days: string) => void;
}) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <NativeSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Window"
      className="w-full sm:w-52"
    >
      {all.map((d) => (
        <option key={d} value={d}>
          {label(d)}
        </option>
      ))}
    </NativeSelect>
  );
}

function MedicineCell({
  medicine,
}: {
  medicine: { id: string; name: string; genericName: string | null; category: string };
}) {
  return (
    <TableCell>
      <Link to={`/medicines/${medicine.id}`} className="font-medium hover:underline">
        {medicine.name}
      </Link>
      <p className="text-xs text-muted-foreground">
        {[medicine.genericName, medicine.category].filter(Boolean).join(' · ')}
      </p>
    </TableCell>
  );
}

// ─── Dead stock ─────────────────────────────────────────────────────────────

export function DeadStockView({ params }: { params: ReportParams }) {
  const { update } = params;
  const { filters, page, pageSize } = params.params;
  const query = {
    days: positiveInt(filters.days),
    categoryId: filters.categoryId || undefined,
    page,
    pageSize,
  };
  const report = useReport('dead-stock', query, reportsApi.deadStock);
  const days = report.data?.days ?? query.days ?? 60;

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="dead-stock" query={query} />}>
        <DaysSelect
          value={days}
          options={[30, 60, 90, 180, 365]}
          label={(d) => `No sale in ${d} days`}
          onChange={(value) => update({ days: value })}
        />
        <CategoryFilter
          value={filters.categoryId}
          onChange={(categoryId) => update({ categoryId })}
        />
      </ListToolbar>

      {report.data && (
        <StatGrid>
          <StatTile label="Medicines" value={report.data.totals.medicines.toLocaleString()} />
          <StatTile label="Units" value={report.data.totals.units.toLocaleString()} />
          <StatTile
            label="Tied up at cost"
            value={formatMoney(report.data.totals.costValue)}
            tone={report.data.totals.medicines > 0 ? 'warn' : undefined}
          />
          <StatTile label="At selling price" value={formatMoney(report.data.totals.retailValue)} />
        </StatGrid>
      )}

      <ListView
        query={report}
        filtered={!!filters.categoryId}
        onClearFilters={() => update({ categoryId: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={5}
        empty={
          <EmptyState
            icon={CircleCheckIcon}
            title="No dead stock"
            description={`Everything in stock has sold within the last ${days} days, or arrived since.`}
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medicine</TableHead>
                    <NumHead>In stock</NumHead>
                    <NumHead>Cost value</NumHead>
                    <NumHead className="hidden sm:table-cell">Retail value</NumHead>
                    <TableHead>Last sold</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((row) => (
                    <TableRow key={row.medicine.id}>
                      <MedicineCell medicine={row.medicine} />
                      <Num>{formatQuantity(row.sellableQuantity, row.medicine.unit)}</Num>
                      <Num className="font-semibold">{formatMoney(row.costValue)}</Num>
                      <Num className="hidden sm:table-cell">{formatMoney(row.retailValue)}</Num>
                      <TableCell className="text-sm whitespace-nowrap">
                        {row.lastSoldAt ? formatDateTime(row.lastSoldAt) : 'Never'}
                        <p className="text-xs text-muted-foreground">
                          In stock since {formatDateTime(row.oldestStockReceivedAt)}
                        </p>
                      </TableCell>
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

// ─── Expiry ─────────────────────────────────────────────────────────────────

const BUCKET_LABELS: Record<ExpiryBucket, string> = {
  EXPIRED: 'Expired, on the shelf',
  DAYS_30: 'Within 30 days',
  DAYS_60: '31–60 days',
  DAYS_90: '61–90 days',
  LATER: 'Over 90 days',
};

export function ExpiryView({ params }: { params: ReportParams }) {
  const { update } = params;
  const { filters, page, pageSize } = params.params;
  const query = { days: positiveInt(filters.days), page, pageSize };
  const report = useReport('expiry', query, reportsApi.expiry);
  const days = report.data?.days ?? query.days ?? 90;

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="expiry" query={query} />}>
        <DaysSelect
          value={days}
          options={[30, 60, 90, 180, 365]}
          label={(d) => `Expiring within ${d} days`}
          onChange={(value) => update({ days: value })}
        />
      </ListToolbar>

      {report.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {report.data.buckets.map((b) => (
            <StatTile
              key={b.bucket}
              label={BUCKET_LABELS[b.bucket]}
              value={formatMoney(b.costValue)}
              tone={b.bucket === 'EXPIRED' && b.batches > 0 ? 'bad' : undefined}
              sub={`${b.batches} ${b.batches === 1 ? 'batch' : 'batches'} · ${b.units.toLocaleString()} units, at cost`}
            />
          ))}
        </div>
      )}

      <ListView
        query={report}
        filtered={false}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={CircleCheckIcon}
            title="Nothing expiring"
            description={`No batch with stock has expired or expires within ${days} days.`}
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medicine</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead>Expiry</TableHead>
                    <NumHead>Qty</NumHead>
                    <NumHead className="hidden sm:table-cell">Cost value</NumHead>
                    <TableHead className="hidden md:table-cell">Supplier</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((row) => {
                    const status = expiryStatus(row);
                    return (
                      <TableRow key={row.batch.id} className={toneRowClass(status.tone)}>
                        <MedicineCell medicine={row.medicine} />
                        <TableCell className="font-mono text-sm whitespace-nowrap">
                          {row.batch.batchNumber}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatDate(row.batch.expiryDate)}
                          <div className="mt-1">
                            <ToneBadge status={status} />
                          </div>
                        </TableCell>
                        <Num>{formatQuantity(row.quantity, row.medicine.unit)}</Num>
                        <Num className="hidden sm:table-cell">{formatMoney(row.costValue)}</Num>
                        <TableCell className="hidden md:table-cell">{row.supplier.name}</TableCell>
                      </TableRow>
                    );
                  })}
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

// ─── Low stock ──────────────────────────────────────────────────────────────

export function LowStockView({ params }: { params: ReportParams }) {
  const { update } = params;
  const { filters, page, pageSize } = params.params;
  const query = { categoryId: filters.categoryId || undefined, page, pageSize };
  const report = useReport('low-stock', query, reportsApi.lowStock);

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="low-stock" query={query} />}>
        <CategoryFilter
          value={filters.categoryId}
          onChange={(categoryId) => update({ categoryId })}
        />
      </ListToolbar>

      <ListView
        query={report}
        filtered={!!filters.categoryId}
        onClearFilters={() => update({ categoryId: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={CircleCheckIcon}
            title="Nothing to reorder"
            description="Every active medicine has more sellable stock than its reorder level."
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medicine</TableHead>
                    <NumHead>Sellable</NumHead>
                    <NumHead className="hidden sm:table-cell">Short by</NumHead>
                    <NumHead>Sold (30 days)</NumHead>
                    <NumHead className="hidden sm:table-cell">Lasts</NumHead>
                    <TableHead className="hidden md:table-cell">Last supplier</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((row) => {
                    const status = stockStatus({
                      sellableQuantity: row.sellableQuantity,
                      isLowStock: true,
                    });
                    return (
                      <TableRow key={row.medicine.id} className={toneRowClass(status.tone)}>
                        <MedicineCell medicine={row.medicine} />
                        <Num className="font-semibold">
                          {row.sellableQuantity.toLocaleString()}
                          <p className="text-xs font-normal text-muted-foreground">
                            reorder at {row.medicine.reorderLevel}
                          </p>
                        </Num>
                        <Num className="hidden sm:table-cell">
                          {row.shortBy > 0 ? row.shortBy.toLocaleString() : '—'}
                        </Num>
                        <Num>{row.soldLast30Days.toLocaleString()}</Num>
                        <Num className="hidden sm:table-cell">
                          {row.daysOfCover === null
                            ? '—'
                            : row.daysOfCover === 0
                              ? 'Out'
                              : `${row.daysOfCover} days`}
                        </Num>
                        <TableCell className="hidden md:table-cell">
                          {row.lastSupplier ? (
                            <>
                              {row.lastSupplier.name}
                              {row.lastCostPrice && (
                                <p className="text-xs text-muted-foreground">
                                  {formatMoney(row.lastCostPrice)} per {row.medicine.unit}
                                </p>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
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

// ─── Supplier purchases ─────────────────────────────────────────────────────

export function SuppliersView({ params }: { params: ReportParams }) {
  const { range, update } = params;
  const supplierId = params.params.filters.supplierId || undefined;
  const query = { from: range.from, to: range.to, supplierId };
  const report = useReport('supplier-purchases', query, reportsApi.supplierPurchases);

  return (
    <div className="space-y-4">
      <ListToolbar actions={<ExportButton path="supplier-purchases" query={query} />}>
        <RangeFilter range={range} onChange={update} />
        {supplierId && (
          <Button variant="ghost" onClick={() => update({ supplierId: '' })}>
            <ArrowLeftIcon /> All suppliers
          </Button>
        )}
      </ListToolbar>

      <ReportState query={report}>
        {(data) =>
          data.suppliers.length === 0 ? (
            <EmptyState
              icon={TruckIcon}
              title="No stock received in this range"
              description="Purchases appear here once stock is received from a supplier."
            />
          ) : (
            <>
              <StatGrid>
                <StatTile label="Purchase value" value={formatMoney(data.totals.value)} />
                <StatTile label="Batches received" value={data.totals.batches.toLocaleString()} />
                <StatTile label="Units" value={data.totals.units.toLocaleString()} />
                <StatTile label="Suppliers" value={data.totals.suppliers.toLocaleString()} />
              </StatGrid>

              {data.lines ? (
                <Section title={`Received from ${data.suppliers[0]?.supplier.name ?? 'supplier'}`}>
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Received</TableHead>
                          <TableHead>Medicine</TableHead>
                          <TableHead className="hidden sm:table-cell">Batch</TableHead>
                          <NumHead>Qty</NumHead>
                          <NumHead className="hidden sm:table-cell">Cost</NumHead>
                          <NumHead>Value</NumHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.lines.map((line) => (
                          <TableRow key={`${line.batch.id}-${line.receivedAt}`}>
                            <TableCell className="text-sm whitespace-nowrap">
                              {formatDateTime(line.receivedAt)}
                              {line.reference && (
                                <p className="text-xs text-muted-foreground">{line.reference}</p>
                              )}
                            </TableCell>
                            <MedicineCell medicine={line.medicine} />
                            <TableCell className="hidden font-mono text-sm whitespace-nowrap sm:table-cell">
                              {line.batch.batchNumber}
                            </TableCell>
                            <Num>{line.quantity.toLocaleString()}</Num>
                            <Num className="hidden sm:table-cell">
                              {formatMoney(line.costPrice)}
                            </Num>
                            <Num className="font-semibold">{formatMoney(line.value)}</Num>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </Section>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead>
                        <NumHead>Batches</NumHead>
                        <NumHead className="hidden sm:table-cell">Medicines</NumHead>
                        <NumHead className="hidden sm:table-cell">Units</NumHead>
                        <NumHead>Value</NumHead>
                        <TableHead className="hidden md:table-cell">Last delivery</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.suppliers.map((row) => (
                        <TableRow key={row.supplier.id}>
                          <TableCell>
                            <button
                              type="button"
                              className="flex items-center gap-2 font-medium hover:underline"
                              onClick={() => update({ supplierId: row.supplier.id })}
                            >
                              <PackageSearchIcon className="size-4 text-muted-foreground" />
                              {row.supplier.name}
                            </button>
                          </TableCell>
                          <Num>{row.batches.toLocaleString()}</Num>
                          <Num className="hidden sm:table-cell">
                            {row.medicines.toLocaleString()}
                          </Num>
                          <Num className="hidden sm:table-cell">{row.units.toLocaleString()}</Num>
                          <Num className="font-semibold">{formatMoney(row.value)}</Num>
                          <TableCell className="hidden text-sm md:table-cell">
                            {formatDateTime(row.lastReceivedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )
        }
      </ReportState>
    </div>
  );
}
