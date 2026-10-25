import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon, CheckCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCurrentUser } from '@/features/auth/auth-context';
import { STAFF_ROLES } from '@/lib/navigation';
import { AlertRow } from './alert-row';
import { alertKeys, alertsApi, invalidateAlerts, useAlertSummary } from './alerts-api';

const PREVIEW = { state: 'unread', page: 1, pageSize: 5 } as const;

/** Header bell: the unread-alert count, and the latest few with a link to all. */
export function AlertsBell() {
  const user = useCurrentUser();
  const canAcknowledge = STAFF_ROLES.includes(user.role);
  const client = useQueryClient();
  const { pathname } = useLocation();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;

  const summary = useAlertSummary();
  const unread = summary.data?.unread ?? 0;
  const latest = useQuery({
    queryKey: alertKeys.list(PREVIEW),
    queryFn: ({ signal }) => alertsApi.list(PREVIEW, signal),
    enabled: open,
  });
  const acknowledgeAll = useMutation({
    mutationFn: () => alertsApi.acknowledgeAll({}),
    onSuccess: () => invalidateAlerts(client),
  });

  const label = unread === 0 ? 'Alerts: none unread' : `Alerts: ${unread} unread`;

  return (
    <Popover open={open} onOpenChange={(next) => setOpenOn(next ? pathname : null)}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label} title={label}>
          <BellIcon className="size-5" />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute top-1 right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] leading-none font-semibold text-white tabular-nums"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-semibold">Alerts</p>
          {canAcknowledge && unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => acknowledgeAll.mutate()}
              disabled={acknowledgeAll.isPending}
            >
              <CheckCheckIcon /> Mark all seen
            </Button>
          )}
        </div>
        <div className="max-h-96 divide-y overflow-y-auto px-4">
          {latest.isPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : latest.isError ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Could not load alerts.</p>
          ) : latest.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing new. Stock and expiry are checked every few minutes.
            </p>
          ) : (
            latest.data.items.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                canAcknowledge={canAcknowledge}
                compact
                onNavigate={() => setOpenOn(null)}
              />
            ))
          )}
        </div>
        <div className="border-t px-4 py-2">
          <Button asChild variant="link" className="h-8 px-0">
            <Link to="/alerts">
              View all alerts
              {summary.data && summary.data.active > unread && ` (${summary.data.active} open)`}
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
