import type { AlertDto } from '@pharmacy/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  ALERT_TYPE_ICONS,
  ALERT_TYPE_LABELS,
  alertLink,
  alertsApi,
  invalidateAlerts,
  severityTone,
} from './alerts-api';

const toneClass = {
  danger: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  ok: 'bg-muted text-muted-foreground',
};

/** One alert: icon and type (never colour alone), the message, and who cleared it. */
export function AlertRow({
  alert,
  canAcknowledge,
  compact,
  onNavigate,
}: {
  alert: AlertDto;
  canAcknowledge: boolean;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const client = useQueryClient();
  const acknowledge = useMutation({
    mutationFn: () => alertsApi.acknowledge(alert.id),
    onSuccess: () => invalidateAlerts(client),
  });
  const Icon = ALERT_TYPE_ICONS[alert.type];
  const tone = alert.status === 'RESOLVED' ? 'ok' : severityTone(alert.severity);

  return (
    <div
      className={cn(
        'flex gap-3',
        compact ? 'py-2' : 'p-4',
        alert.status === 'OPEN' ? '' : 'opacity-75',
      )}
    >
      <div
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full',
          toneClass[tone],
        )}
      >
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{ALERT_TYPE_LABELS[alert.type]}</span>
          {alert.severity === 'CRITICAL' && alert.status !== 'RESOLVED' && (
            <Badge variant="danger">Critical</Badge>
          )}
          {alert.status === 'ACKNOWLEDGED' && <Badge variant="secondary">Seen</Badge>}
          {alert.status === 'RESOLVED' && <Badge variant="success">Resolved</Badge>}
        </div>
        <Link
          to={alertLink(alert)}
          onClick={onNavigate}
          className="block text-sm text-foreground hover:underline"
        >
          {alert.message}
        </Link>
        <p className="text-xs text-muted-foreground">
          Since {formatDateTime(alert.createdAt)}
          {alert.acknowledgedBy &&
            ` · seen by ${alert.acknowledgedBy.fullName}${alert.acknowledgedAt ? `, ${formatDateTime(alert.acknowledgedAt)}` : ''}`}
          {alert.resolvedAt && ` · resolved ${formatDateTime(alert.resolvedAt)}`}
        </p>
      </div>
      {canAcknowledge && alert.status === 'OPEN' && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => acknowledge.mutate()}
          disabled={acknowledge.isPending}
          aria-label={`Mark "${alert.message}" as seen`}
        >
          <CheckIcon /> {compact ? '' : 'Seen'}
        </Button>
      )}
    </div>
  );
}
