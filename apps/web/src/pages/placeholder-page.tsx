import { ConstructionIcon } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

/** Stand-in for screens that later sessions build. */
export function PlaceholderPage({ title, session }: { title: string; session?: number }) {
  return (
    <EmptyState
      icon={ConstructionIcon}
      title={title}
      description={`This screen is built in ${session ? `Session ${session}` : 'a later session'}.`}
    />
  );
}
