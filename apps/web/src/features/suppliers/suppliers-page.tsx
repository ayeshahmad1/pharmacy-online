import type { SupplierDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PackagePlusIcon, PencilIcon, PlusIcon, PowerIcon, TruckIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import {
  ListToolbar,
  PageIntro,
  STATUS_FILTER_DEFAULT,
  StatusFilter,
  statusQuery,
} from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { RowActions } from '@/components/data/row-actions';
import { SearchInput } from '@/components/data/search-input';
import { RecordStatusBadge } from '@/components/status-badges';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActivationDialog, type ActivationTarget } from '@/features/catalog/activation-dialog';
import { catalogKeys, suppliersApi } from '@/features/catalog/catalog-api';
import { useListParams } from '@/lib/list-params';
import { SupplierFormDialog } from './supplier-form-dialog';

export function SuppliersPage() {
  const { params, update } = useListParams(['status'], { status: STATUS_FILTER_DEFAULT });
  const query = {
    q: params.q || undefined,
    status: statusQuery(params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const suppliers = useQuery({
    queryKey: [...catalogKeys.suppliers, 'list', query],
    queryFn: ({ signal }) => suppliersApi.list(query, signal),
    placeholderData: keepPreviousData,
  });

  const [formTarget, setFormTarget] = useState<SupplierDto | 'new' | null>(null);
  const [activation, setActivation] = useState<ActivationTarget | null>(null);
  const filtered = !!params.q || params.filters.status !== STATUS_FILTER_DEFAULT;

  return (
    <div className="space-y-4">
      <PageIntro description="Who stock is received from. Every batch records its supplier." />
      <ListToolbar
        actions={
          <Button onClick={() => setFormTarget('new')}>
            <PlusIcon /> New supplier
          </Button>
        }
      >
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search name, contact or phone"
          className="sm:w-80"
        />
        <StatusFilter value={params.filters.status} onChange={(status) => update({ status })} />
      </ListToolbar>

      <ListView
        query={suppliers}
        filtered={filtered}
        onClearFilters={() => update({ q: '', status: STATUS_FILTER_DEFAULT })}
        onFirstPage={() => update({ page: 1 })}
        columns={5}
        empty={
          <EmptyState
            icon={TruckIcon}
            title="No suppliers yet"
            description="Add the distributors you buy from, then receive stock against them."
            action={
              <Button onClick={() => setFormTarget('new')}>
                <PlusIcon /> New supplier
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
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden sm:table-cell">Contact</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="hidden lg:table-cell">Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((supplier) => (
                    <TableRow key={supplier.id}>
                      <TableCell className="font-medium">
                        {supplier.name}
                        {supplier.address && (
                          <p className="max-w-xs truncate text-xs font-normal text-muted-foreground">
                            {supplier.address}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {supplier.contactPerson ?? '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {supplier.phone ? (
                          <a href={`tel:${supplier.phone}`} className="hover:underline">
                            {supplier.phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {supplier.email ?? '—'}
                      </TableCell>
                      <TableCell>
                        <RecordStatusBadge status={supplier.status} />
                      </TableCell>
                      <TableCell>
                        <RowActions label={`Actions for ${supplier.name}`}>
                          {supplier.status === 'ACTIVE' && (
                            <DropdownMenuItem asChild>
                              <Link to={`/deliveries/new?supplierId=${supplier.id}`}>
                                <PackagePlusIcon /> Receive stock
                              </Link>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => setFormTarget(supplier)}>
                            <PencilIcon /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant={supplier.status === 'ACTIVE' ? 'destructive' : 'default'}
                            onSelect={() => setActivation(supplier)}
                          >
                            <PowerIcon />
                            {supplier.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                          </DropdownMenuItem>
                        </RowActions>
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

      {formTarget && (
        <SupplierFormDialog
          key={formTarget === 'new' ? 'new' : formTarget.id}
          open
          onOpenChange={(open) => !open && setFormTarget(null)}
          supplier={formTarget === 'new' ? null : formTarget}
        />
      )}
      <ActivationDialog
        entity="supplier"
        target={activation}
        onClose={() => setActivation(null)}
        setActive={suppliersApi.setActive}
      />
    </div>
  );
}
