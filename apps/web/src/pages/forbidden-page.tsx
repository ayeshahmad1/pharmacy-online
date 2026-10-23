import { ShieldAlertIcon } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';

export function ForbiddenPage() {
  return (
    <EmptyState
      icon={ShieldAlertIcon}
      title="No access"
      description="Your role does not allow access to this page. Ask an administrator if you need it."
      action={
        <Button asChild variant="outline">
          <Link to="/">Go to my home page</Link>
        </Button>
      }
    />
  );
}
