import { SearchXIcon } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={SearchXIcon}
      title="Page not found"
      description="The page you are looking for does not exist."
      action={
        <Button asChild variant="outline">
          <Link to="/">Go to my home page</Link>
        </Button>
      }
    />
  );
}
