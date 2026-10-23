import { Loader2Icon } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';

export function SplashScreen() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4" role="status">
      <BrandMark className="size-12" />
      <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
