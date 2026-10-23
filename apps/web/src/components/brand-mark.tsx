import { cn } from '@/lib/utils';

/** The app logo: a white cross on a teal tile. Same artwork as public/favicon.svg. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-8 shrink-0', className)}>
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" className="fill-primary-foreground" />
    </svg>
  );
}
