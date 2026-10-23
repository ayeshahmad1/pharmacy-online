import type {
  CategoryDto,
  CreateCategoryBody,
  CreateMedicineBody,
  CreateSupplierBody,
  ListCategoriesQuery,
  ListMedicinesQuery,
  ListSuppliersQuery,
  MedicineDto,
  Paginated,
  SupplierDto,
  UpdateCategoryBody,
  UpdateMedicineBody,
  UpdateSupplierBody,
} from '@pharmacy/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Query keys are prefixes, so invalidating ['medicines'] refreshes every
// medicine list and detail at once.
export const catalogKeys = {
  medicines: ['medicines'] as const,
  categories: ['categories'] as const,
  suppliers: ['suppliers'] as const,
};

type ListQuery<T> = Partial<T>;

// ─── Medicines ──────────────────────────────────────────────────────────────

export const medicinesApi = {
  list: (query: ListQuery<ListMedicinesQuery>, signal?: AbortSignal) =>
    api.get<Paginated<MedicineDto>>('/medicines', query, signal),
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<{ medicine: MedicineDto }>(`/medicines/${id}`, undefined, signal)).medicine,
  create: async (body: CreateMedicineBody) =>
    (await api.post<{ medicine: MedicineDto }>('/medicines', body)).medicine,
  update: async (id: string, body: UpdateMedicineBody) =>
    (await api.patch<{ medicine: MedicineDto }>(`/medicines/${id}`, body)).medicine,
  setActive: async (id: string, active: boolean) =>
    (
      await api.post<{ medicine: MedicineDto }>(
        `/medicines/${id}/${active ? 'activate' : 'deactivate'}`,
      )
    ).medicine,
};

// ─── Categories ─────────────────────────────────────────────────────────────

export const categoriesApi = {
  list: (query: ListQuery<ListCategoriesQuery>, signal?: AbortSignal) =>
    api.get<Paginated<CategoryDto>>('/categories', query, signal),
  create: async (body: CreateCategoryBody) =>
    (await api.post<{ category: CategoryDto }>('/categories', body)).category,
  update: async (id: string, body: UpdateCategoryBody) =>
    (await api.patch<{ category: CategoryDto }>(`/categories/${id}`, body)).category,
  setActive: async (id: string, active: boolean) =>
    (
      await api.post<{ category: CategoryDto }>(
        `/categories/${id}/${active ? 'activate' : 'deactivate'}`,
      )
    ).category,
};

// ─── Suppliers ──────────────────────────────────────────────────────────────

export const suppliersApi = {
  list: (query: ListQuery<ListSuppliersQuery>, signal?: AbortSignal) =>
    api.get<Paginated<SupplierDto>>('/suppliers', query, signal),
  get: async (id: string, signal?: AbortSignal) =>
    (await api.get<{ supplier: SupplierDto }>(`/suppliers/${id}`, undefined, signal)).supplier,
  create: async (body: CreateSupplierBody) =>
    (await api.post<{ supplier: SupplierDto }>('/suppliers', body)).supplier,
  update: async (id: string, body: UpdateSupplierBody) =>
    (await api.patch<{ supplier: SupplierDto }>(`/suppliers/${id}`, body)).supplier,
  setActive: async (id: string, active: boolean) =>
    (
      await api.post<{ supplier: SupplierDto }>(
        `/suppliers/${id}/${active ? 'activate' : 'deactivate'}`,
      )
    ).supplier,
};

/**
 * What to refresh after a catalogue write. Names appear in other lists too:
 * a renamed category shows on medicines, a renamed medicine or supplier on
 * stock and batch lists.
 */
export function invalidateAfterCatalogWrite(
  client: QueryClient,
  entity: 'medicine' | 'category' | 'supplier',
) {
  const keys =
    entity === 'category'
      ? [catalogKeys.categories, catalogKeys.medicines]
      : entity === 'supplier'
        ? [catalogKeys.suppliers, ['inventory']]
        : [catalogKeys.medicines, ['inventory']];
  return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}
