import type { RecordStatus } from '@pharmacy/shared';
import { AlertTriangleIcon, CircleCheckIcon, OctagonAlertIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Status, Tone } from '@/lib/stock-status';

const toneVariant = { danger: 'danger', warning: 'warning', ok: 'success' } as const;
const toneIcon = { danger: OctagonAlertIcon, warning: AlertTriangleIcon, ok: CircleCheckIcon };

/** A stock or expiry warning. Icon and text as well as colour, so it reads in any theme. */
export function ToneBadge({ status, hideOk }: { status: Status; hideOk?: boolean }) {
  if (hideOk && status.tone === 'ok') return null;
  const Icon = toneIcon[status.tone];
  return (
    <Badge variant={toneVariant[status.tone]}>
      <Icon />
      {status.label}
    </Badge>
  );
}

export function RecordStatusBadge({ status }: { status: RecordStatus }) {
  return status === 'ACTIVE' ? (
    <Badge variant="success">Active</Badge>
  ) : (
    <Badge variant="secondary">Inactive</Badge>
  );
}

/** Row tint for a warning tone; pairs with ToneBadge. */
export function toneRowClass(tone: Tone) {
  if (tone === 'danger')
    return 'bg-red-50/70 hover:bg-red-50 dark:bg-red-950/25 dark:hover:bg-red-950/40';
  if (tone === 'warning') {
    return 'bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/35';
  }
  return '';
}
