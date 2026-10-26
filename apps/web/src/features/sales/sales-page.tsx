import { SALE_STATUSES } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReceiptTextIcon, ScanBarcodeIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar, PageIntro } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCurrentUser } from '@/features/auth/auth-context';
import { PAYMENT_LABELS } from '@/features/billing/payments';
import { formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { salesApi, salesKeys } from './sales-api';
import { SALE_STATUS_LABELS, SaleStatusBadge } from './status-badges';

const FILTERS = ['status', 'cashierId', 'from', 'to'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sales newest first. Cashiers see only their own (the API enforces it). */
export function SalesPage() {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const navigate = useNavigate();
  const { params, update } = useListParams(FILTERS);
  const { status, cashierId } = params.filters;

  // Hand-edited URLs or a from after to: drop or swap rather than fail the list.
  let from = DATE.test(params.filters.from) ? params.filters.from : '';
  let to = DATE.test(params.filters.to) ? params.filters.to : '';
  if (from && to && from > to) [from, to] = [to, from];

  const query = {
    q: params.q || undefined,
    status: SALE_STATUSES.find((s) => s === status),
    cashierId: isStaff && cashierId ? cashierId : undefined,
    from: from || undefined,
    to: to || undefined,
    page: params.page,
    pageSize: params.pageSize,
  };
  const sales = useQuery({
    queryKey: salesKeys.list(query),
    queryFn: ({ signal }) => salesApi.list(query, signal),
    placeholderData: keepPreviousData,
  });
  const cashiers = useQuery({
    queryKey: salesKeys.cashiers,
    queryFn: ({ signal }) => salesApi.cashiers(signal),
    enabled: isStaff,
    staleTime: 5 * 60_000,
  });

  const filtered = !!params.q || FILTERS.some((key) => params.filters[key] !== '');

  return (
    <div className="space-y-4">
      <PageIntro
        description={
          isStaff
            ? 'Every sale rung up at the counter. Open one to reprint its receipt, take a return or void it.'
            : 'The sales you rang up. Open one to reprint its receipt or take a return.'
        }
      />
      <ListToolbar
        actions={
          <Button asChild variant="outline">
            <Link to="/billing">
              <ScanBarcodeIcon /> New sale
            </Link>
          </Button>
        }
      >
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search receipt number"
          className="sm:w-64"
        />
        <NativeSelect
          value={status}
          onChange={(e) => update({ status: e.target.value })}
          aria-label="Status"
          className="w-full sm:w-40"
        >
          <option value="">All statuses</option>
          {SALE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SALE_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        {isStaff && (
          <NativeSelect
            value={cashierId}
            onChange={(e) => update({ cashierId: e.target.value })}
            aria-label="Cashier"
            className="w-full sm:w-48"
            disabled={cashiers.isPending && !cashiers.data}
          >
            <option value="">All cashiers</option>
            {cashiers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName}
              </option>
            ))}
          </NativeSelect>
        )}
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="From date"
            value={from}
            max={to || undefined}
            onChange={(e) => update({ from: e.target.value })}
            className="w-full sm:w-40"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="To date"
            value={to}
            min={from || undefined}
            onChange={(e) => update({ to: e.target.value })}
            className="w-full sm:w-40"
          />
        </div>
      </ListToolbar>

      <ListView
        query={sales}
        filtered={filtered}
        onClearFilters={() => update({ q: '', status: '', cashierId: '', from: '', to: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={ReceiptTextIcon}
            title="No sales yet"
            description={
              isStaff
                ? 'Sales appear here as soon as they are rung up at the counter.'
                : 'Sales you ring up at the counter appear here.'
            }
            action={
              <Button asChild>
                <Link to="/billing">
                  <ScanBarcodeIcon /> Go to billing
                </Link>
              </Button>
            }
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Sold</TableHead>
                    {isStaff && <TableHead className="hidden md:table-cell">Cashier</TableHead>}
                    <TableHead className="hidden sm:table-cell">Items</TableHead>
                    <TableHead className="hidden lg:table-cell">Paid by</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((sale) => (
                    <TableRow
                      key={sale.id}
                      className="cursor-pointer"
                      onClick={() => void navigate(`/sales/${sale.id}`)}
                    >
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        <Link
                          to={`/sales/${sale.id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {sale.receiptNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(sale.soldAt)}
                      </TableCell>
                      {isStaff && (
                        <TableCell className="hidden md:table-cell">
                          {sale.cashier.fullName}
                        </TableCell>
                      )}
                      <TableCell className="hidden tabular-nums sm:table-cell">
                        {sale.itemCount}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {sale.paymentMethods.map((m) => PAYMENT_LABELS[m]).join(', ') || '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                        {formatMoney(sale.grandTotal)}
                      </TableCell>
                      <TableCell>
                        <SaleStatusBadge status={sale.status} />
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
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </ListView>
    </div>
  );
}
