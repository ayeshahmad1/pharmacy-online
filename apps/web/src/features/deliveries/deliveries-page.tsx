import { DELIVERY_STATUSES } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PackagePlusIcon, PlusIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { ListToolbar, PageIntro } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { SearchInput } from '@/components/data/search-input';
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
import { useCurrentUser } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { deliveriesApi, deliveriesKeys } from './deliveries-api';
import { DELIVERY_STATUS_LABELS, DeliveryStatusBadge } from './delivery-status';

/** Supplier deliveries newest first. Cashiers see only the ones they entered (the API enforces it). */
export function DeliveriesPage() {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const navigate = useNavigate();
  const { params, update } = useListParams(['status']);
  const query = {
    q: params.q || undefined,
    status: DELIVERY_STATUSES.find((s) => s === params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const deliveries = useQuery({
    queryKey: deliveriesKeys.list(query),
    queryFn: ({ signal }) => deliveriesApi.list(query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = !!params.q || params.filters.status !== '';
  const newDelivery = (
    <Button asChild>
      <Link to="/deliveries/new">
        <PlusIcon /> Receive stock
      </Link>
    </Button>
  );

  return (
    <div className="space-y-4">
      <PageIntro
        description={
          isStaff
            ? 'Supplier deliveries. The ones cashiers enter wait here until you check them against the invoice and approve them.'
            : 'Deliveries you entered. Each one waits for a pharmacist or admin to approve it before its stock can be sold.'
        }
      />
      <ListToolbar actions={newDelivery}>
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search supplier or invoice"
          className="sm:w-64"
        />
        <NativeSelect
          value={params.filters.status}
          onChange={(e) => update({ status: e.target.value })}
          aria-label="Status"
          className="w-full sm:w-48"
        >
          <option value="">All statuses</option>
          {DELIVERY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DELIVERY_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </ListToolbar>

      <ListView
        query={deliveries}
        filtered={filtered}
        onClearFilters={() => update({ q: '', status: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={PackagePlusIcon}
            title="No deliveries yet"
            description="When stock arrives from a supplier, enter it here from the invoice."
            action={newDelivery}
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Entered</TableHead>
                    <TableHead className="hidden sm:table-cell">Invoice</TableHead>
                    {isStaff && <TableHead className="hidden xl:table-cell">Entered by</TableHead>}
                    <TableHead className="hidden text-right lg:table-cell">Batches</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((d) => (
                    <TableRow
                      key={d.id}
                      className="cursor-pointer"
                      onClick={() => void navigate(`/deliveries/${d.id}`)}
                    >
                      <TableCell className="min-w-40 whitespace-normal">
                        <Link
                          to={`/deliveries/${d.id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {d.supplier.name}
                        </Link>
                        {d.newMedicineCount > 0 && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            {d.status === 'PENDING' ? 'Has new medicines' : 'Added new medicines'}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(d.requestedAt)}
                      </TableCell>
                      <TableCell className="hidden font-mono text-sm sm:table-cell">
                        {d.invoiceNumber ?? '—'}
                      </TableCell>
                      {isStaff && (
                        <TableCell className="hidden xl:table-cell">
                          {d.requestedBy.fullName}
                        </TableCell>
                      )}
                      <TableCell className="hidden text-right tabular-nums lg:table-cell">
                        {d.lineCount}
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                        {formatMoney(d.totalCost)}
                      </TableCell>
                      <TableCell>
                        <DeliveryStatusBadge status={d.status} />
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
