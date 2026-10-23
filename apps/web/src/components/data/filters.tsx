import type { RecordStatus } from '@pharmacy/shared';
import type { ReactNode } from 'react';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

/** Lists show active records unless asked; "all" drops the filter. */
export const STATUS_FILTER_DEFAULT = 'ACTIVE';

export function statusQuery(filter: string): RecordStatus | undefined {
  return filter === 'ACTIVE' || filter === 'INACTIVE' ? filter : undefined;
}

export function StatusFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <NativeSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Status"
      className="w-full sm:w-36"
    >
      <option value="ACTIVE">Active</option>
      <option value="INACTIVE">Inactive</option>
      <option value="all">All statuses</option>
    </NativeSelect>
  );
}

/** Search, filters and the page's main action, wrapping on narrow screens. */
export function ListToolbar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      {children}
      {actions && <div className="flex gap-2 sm:ml-auto">{actions}</div>}
    </div>
  );
}

export function PageIntro({
  title,
  description,
  className,
}: {
  title?: string;
  description: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      {title && <h2 className="text-xl font-semibold">{title}</h2>}
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
