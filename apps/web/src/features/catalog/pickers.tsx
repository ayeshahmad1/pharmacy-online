import type { MedicineDto, SupplierDto } from '@pharmacy/shared';
import type { Ref } from 'react';
import { AsyncCombobox } from '@/components/data/async-combobox';
import { formatMoney } from '@/lib/money';
import { catalogKeys, medicinesApi, suppliersApi } from './catalog-api';

type PickerProps<T> = {
  id?: string;
  value: T | null;
  onChange: (value: T | null) => void;
  inputRef?: Ref<HTMLInputElement>;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};

/** Search active medicines by brand or generic name. */
export function MedicinePicker(props: PickerProps<MedicineDto>) {
  return (
    <AsyncCombobox
      {...props}
      queryKey={(q) => [...catalogKeys.medicines, 'picker', q]}
      search={async (q, signal) =>
        (await medicinesApi.list({ q: q || undefined, status: 'ACTIVE', pageSize: 10 }, signal))
          .items
      }
      getKey={(m) => m.id}
      getLabel={(m) => m.name}
      renderItem={(m) => (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{m.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {m.genericName ?? m.category.name}
            </p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatMoney(m.sellingPrice)}/{m.unit}
          </span>
        </div>
      )}
      placeholder="Search medicine"
      emptyText="No active medicine matches"
    />
  );
}

/** Search active suppliers by name, contact or phone. */
export function SupplierPicker(props: PickerProps<SupplierDto>) {
  return (
    <AsyncCombobox
      {...props}
      queryKey={(q) => [...catalogKeys.suppliers, 'picker', q]}
      search={async (q, signal) =>
        (await suppliersApi.list({ q: q || undefined, status: 'ACTIVE', pageSize: 10 }, signal))
          .items
      }
      getKey={(s) => s.id}
      getLabel={(s) => s.name}
      renderItem={(s) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{s.name}</p>
          {(s.contactPerson || s.phone) && (
            <p className="truncate text-xs text-muted-foreground">
              {[s.contactPerson, s.phone].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      )}
      placeholder="Search supplier"
      emptyText="No active supplier matches"
    />
  );
}
