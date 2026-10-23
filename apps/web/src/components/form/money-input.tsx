import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A PKR amount typed as text ("120.50"). It stays a string all the way to
 * the API: money never passes through a JS number (rule 6).
 */
export function MoneyInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <div className={cn('relative', className)}>
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">
        Rs
      </span>
      <Input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        className="pl-9 text-right tabular-nums"
        {...props}
      />
    </div>
  );
}
