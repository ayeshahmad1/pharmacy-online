import { RETURN_STATUSES } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PlusIcon, Undo2Icon } from 'lucide-react';
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
import { RETURN_STATUS_LABELS, ReturnStatusBadge } from '@/features/sales/status-badges';
import { formatDateTime } from '@/lib/format';
import { useListParams } from '@/lib/list-params';
import { formatMoney } from '@/lib/money';
import { STAFF_ROLES } from '@/lib/navigation';
import { returnsApi, returnsKeys } from './returns-api';

/** The statuses a return is filtered by; VOIDED is not used by the API today. */
const STATUS_OPTIONS = ['PENDING', 'COMPLETED', 'REJECTED'] as const;

/** Returns newest first. Cashiers see only the returns they raised (the API enforces it). */
export function ReturnsPage() {
  const user = useCurrentUser();
  const isStaff = STAFF_ROLES.includes(user.role);
  const navigate = useNavigate();
  const { params, update } = useListParams(['status']);
  const query = {
    q: params.q || undefined,
    status: RETURN_STATUSES.find((s) => s === params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const returns = useQuery({
    queryKey: returnsKeys.list(query),
    queryFn: ({ signal }) => returnsApi.list(query, signal),
    placeholderData: keepPreviousData,
  });
  const filtered = !!params.q || params.filters.status !== '';

  return (
    <div className="space-y-4">
      <PageIntro
        description={
          isStaff
            ? 'Items brought back against a sale. Returns raised by cashiers wait here for your approval.'
            : 'Returns you raised. Each one waits for a pharmacist or admin to approve it.'
        }
      />
      <ListToolbar
        actions={
          <Button asChild>
            <Link to="/returns/new">
              <PlusIcon /> New return
            </Link>
          </Button>
        }
      >
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search return number"
          className="sm:w-64"
        />
        <NativeSelect
          value={params.filters.status}
          onChange={(e) => update({ status: e.target.value })}
          aria-label="Status"
          className="w-full sm:w-48"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {RETURN_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </ListToolbar>

      <ListView
        query={returns}
        filtered={filtered}
        onClearFilters={() => update({ q: '', status: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={Undo2Icon}
            title="No returns yet"
            description="When a customer brings items back, look up their receipt and record the return here."
            action={
              <Button asChild>
                <Link to="/returns/new">
                  <PlusIcon /> New return
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
                    <TableHead>Return</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead className="hidden sm:table-cell">Sale</TableHead>
                    {isStaff && <TableHead className="hidden xl:table-cell">Raised by</TableHead>}
                    <TableHead className="hidden xl:table-cell">Units</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => void navigate(`/returns/${r.id}`)}
                    >
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        <Link
                          to={`/returns/${r.id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.returnNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(r.requestedAt)}
                      </TableCell>
                      <TableCell className="hidden font-mono text-sm whitespace-nowrap sm:table-cell">
                        {r.sale.receiptNumber}
                      </TableCell>
                      {isStaff && (
                        <TableCell className="hidden xl:table-cell">
                          {r.requestedBy.fullName}
                        </TableCell>
                      )}
                      <TableCell className="hidden tabular-nums xl:table-cell">
                        {r.itemCount}
                      </TableCell>
                      <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                        {formatMoney(r.refundTotal)}
                      </TableCell>
                      <TableCell>
                        <ReturnStatusBadge status={r.status} />
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
