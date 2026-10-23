import type { CategoryDto } from '@pharmacy/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PencilIcon, PlusIcon, PowerIcon, TagsIcon } from 'lucide-react';
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
import { catalogKeys, categoriesApi } from '@/features/catalog/catalog-api';
import { useListParams } from '@/lib/list-params';
import { CategoryFormDialog } from './category-form-dialog';

export function CategoriesPage() {
  const { params, update } = useListParams(['status'], { status: STATUS_FILTER_DEFAULT });
  const query = {
    q: params.q || undefined,
    status: statusQuery(params.filters.status),
    page: params.page,
    pageSize: params.pageSize,
  };
  const categories = useQuery({
    queryKey: [...catalogKeys.categories, 'list', query],
    queryFn: ({ signal }) => categoriesApi.list(query, signal),
    placeholderData: keepPreviousData,
  });

  const [formTarget, setFormTarget] = useState<CategoryDto | 'new' | null>(null);
  const [activation, setActivation] = useState<ActivationTarget | null>(null);
  const filtered = !!params.q || params.filters.status !== STATUS_FILTER_DEFAULT;

  return (
    <div className="space-y-4">
      <PageIntro description="Groups for medicines. Deactivated categories stay on existing medicines but cannot take new ones." />
      <ListToolbar
        actions={
          <Button onClick={() => setFormTarget('new')}>
            <PlusIcon /> New category
          </Button>
        }
      >
        <SearchInput
          value={params.q}
          onChange={(q) => update({ q }, { replace: true })}
          placeholder="Search categories"
          className="sm:w-72"
        />
        <StatusFilter value={params.filters.status} onChange={(status) => update({ status })} />
      </ListToolbar>

      <ListView
        query={categories}
        filtered={filtered}
        onClearFilters={() => update({ q: '', status: STATUS_FILTER_DEFAULT })}
        onFirstPage={() => update({ page: 1 })}
        columns={4}
        empty={
          <EmptyState
            icon={TagsIcon}
            title="No categories yet"
            description="Add a category such as Analgesics or Antibiotics before adding medicines."
            action={
              <Button onClick={() => setFormTarget('new')}>
                <PlusIcon /> New category
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
                    <TableHead className="hidden md:table-cell">Description</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((category) => (
                    <TableRow key={category.id}>
                      <TableCell className="font-medium">
                        <Link
                          to={`/medicines?categoryId=${category.id}`}
                          className="hover:underline"
                          title="Show medicines in this category"
                        >
                          {category.name}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">
                        {category.description ?? '—'}
                      </TableCell>
                      <TableCell>
                        <RecordStatusBadge status={category.status} />
                      </TableCell>
                      <TableCell>
                        <RowActions label={`Actions for ${category.name}`}>
                          <DropdownMenuItem onSelect={() => setFormTarget(category)}>
                            <PencilIcon /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant={category.status === 'ACTIVE' ? 'destructive' : 'default'}
                            onSelect={() => setActivation(category)}
                          >
                            <PowerIcon />
                            {category.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
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
        <CategoryFormDialog
          key={formTarget === 'new' ? 'new' : formTarget.id}
          open
          onOpenChange={(open) => !open && setFormTarget(null)}
          category={formTarget === 'new' ? null : formTarget}
        />
      )}
      <ActivationDialog
        entity="category"
        target={activation}
        onClose={() => setActivation(null)}
        setActive={categoriesApi.setActive}
      />
    </div>
  );
}
