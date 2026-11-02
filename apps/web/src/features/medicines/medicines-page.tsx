import type { MedicineDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { EyeIcon, PackagePlusIcon, PencilIcon, PillIcon, PlusIcon, PowerIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
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
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActivationDialog, type ActivationTarget } from '@/features/catalog/activation-dialog';
import { catalogKeys, medicinesApi } from '@/features/catalog/catalog-api';
import { CategoryFilter } from '@/features/catalog/category-filter';
import { useListParams } from '@/lib/list-params';
import { formatMoney } from '@/lib/money';
import { MedicineFormDialog } from './medicine-form-dialog';

export function MedicinesPage() {
  const navigate = useNavigate();
  const { params, update } = useListParams(['status', 'categoryId'], {
    status: STATUS_FILTER_DEFAULT,
  });
  const query = {
    q: params.q || undefined,
    categoryId: params.filters.categoryId || undefined,
    status: statusQuery(params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const medicines = useQuery({
    queryKey: [...catalogKeys.medicines, 'list', query],
    queryFn: ({ signal }) => medicinesApi.list(query, signal),
    placeholderData: keepPreviousData,
  });

  const [formTarget, setFormTarget] = useState<MedicineDto | 'new' | null>(null);
  const [activation, setActivation] = useState<ActivationTarget | null>(null);
  const filtered =
    !!params.q || !!params.filters.categoryId || params.filters.status !== STATUS_FILTER_DEFAULT;

  return (
    <div className="space-y-4">
      <PageIntro description="The medicine catalogue: names, prices and reorder levels. Open a medicine to see its batches and stock." />
      <ListToolbar
        actions={
          <Button onClick={() => setFormTarget('new')}>
            <PlusIcon /> New medicine
          </Button>
        }
      >
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search brand or generic name"
          className="sm:w-80"
          autoFocus
        />
        <CategoryFilter
          value={params.filters.categoryId}
          onChange={(categoryId) => update({ categoryId })}
        />
        <StatusFilter value={params.filters.status} onChange={(status) => update({ status })} />
      </ListToolbar>

      <ListView
        query={medicines}
        filtered={filtered}
        onClearFilters={() => update({ q: '', categoryId: '', status: STATUS_FILTER_DEFAULT })}
        onFirstPage={() => update({ page: 1 })}
        columns={6}
        empty={
          <EmptyState
            icon={PillIcon}
            title="No medicines yet"
            description="Add medicines to the catalogue, then receive stock for them."
            action={
              <Button onClick={() => setFormTarget('new')}>
                <PlusIcon /> New medicine
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
                    <TableHead>Medicine</TableHead>
                    <TableHead className="hidden md:table-cell">Category</TableHead>
                    <TableHead className="hidden sm:table-cell">Unit</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Reorder at</TableHead>
                    <TableHead className="hidden xl:table-cell">Barcode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((medicine) => (
                    <TableRow key={medicine.id}>
                      <TableCell>
                        <Link
                          to={`/medicines/${medicine.id}`}
                          className="font-medium hover:underline"
                        >
                          {medicine.name}
                        </Link>
                        {medicine.genericName && (
                          <p className="text-xs text-muted-foreground">{medicine.genericName}</p>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {medicine.category.name}
                      </TableCell>
                      <TableCell className="hidden capitalize sm:table-cell">
                        {medicine.unit}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {formatMoney(medicine.sellingPrice)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums lg:table-cell">
                        {medicine.reorderLevel}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs xl:table-cell">
                        {medicine.barcode ?? '—'}
                      </TableCell>
                      <TableCell>
                        <RecordStatusBadge status={medicine.status} />
                      </TableCell>
                      <TableCell>
                        <RowActions label={`Actions for ${medicine.name}`}>
                          <DropdownMenuItem asChild>
                            <Link to={`/medicines/${medicine.id}`}>
                              <EyeIcon /> Stock and batches
                            </Link>
                          </DropdownMenuItem>
                          {medicine.status === 'ACTIVE' && (
                            <DropdownMenuItem asChild>
                              <Link to={`/deliveries/new?medicineId=${medicine.id}`}>
                                <PackagePlusIcon /> Receive stock
                              </Link>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => setFormTarget(medicine)}>
                            <PencilIcon /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant={medicine.status === 'ACTIVE' ? 'destructive' : 'default'}
                            onSelect={() => setActivation(medicine)}
                          >
                            <PowerIcon />
                            {medicine.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
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
        <MedicineFormDialog
          key={formTarget === 'new' ? 'new' : formTarget.id}
          open
          onOpenChange={(open) => !open && setFormTarget(null)}
          medicine={formTarget === 'new' ? null : formTarget}
          // A new medicine has no stock yet; its page is where batches go next.
          onSaved={(saved) => formTarget === 'new' && void navigate(`/medicines/${saved.id}`)}
        />
      )}
      <ActivationDialog
        entity="medicine"
        target={activation}
        onClose={() => setActivation(null)}
        setActive={medicinesApi.setActive}
      />
    </div>
  );
}
