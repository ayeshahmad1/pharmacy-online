import { ALERT_STATES, ALERT_TYPES, type AlertState, type AlertType } from '@pharmacy/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOffIcon, CheckCheckIcon, RefreshCwIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ListToolbar, PageIntro } from '@/components/data/filters';
import { ListView } from '@/components/data/list-states';
import { Pagination } from '@/components/data/pagination';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { useCurrentUser } from '@/features/auth/auth-context';
import { useListParams } from '@/lib/list-params';
import { STAFF_ROLES } from '@/lib/navigation';
import { AlertRow } from './alert-row';
import {
  ALERT_TYPE_LABELS,
  alertKeys,
  alertsApi,
  invalidateAlerts,
  useAlertSummary,
} from './alerts-api';

const STATE_LABELS: Record<AlertState, string> = {
  unread: 'Unread',
  active: 'Open',
  resolved: 'Resolved',
  all: 'All',
};

export function AlertsPage() {
  const user = useCurrentUser();
  const canManage = STAFF_ROLES.includes(user.role);
  const client = useQueryClient();
  const { params, update } = useListParams(['state', 'type'] as const, { state: 'active' });
  const state = (ALERT_STATES as readonly string[]).includes(params.filters.state)
    ? (params.filters.state as AlertState)
    : 'active';
  const type = (ALERT_TYPES as readonly string[]).includes(params.filters.type)
    ? (params.filters.type as AlertType)
    : undefined;
  const query = { state, type, page: params.page, pageSize: params.pageSize };

  const summary = useAlertSummary();
  const alerts = useQuery({
    queryKey: alertKeys.list(query),
    queryFn: ({ signal }) => alertsApi.list(query, signal),
    placeholderData: keepPreviousData,
  });
  const acknowledgeAll = useMutation({
    mutationFn: () => alertsApi.acknowledgeAll({ type }),
    onSuccess: async ({ acknowledged }) => {
      toast.success(`${acknowledged} alert${acknowledged === 1 ? '' : 's'} marked as seen`);
      await invalidateAlerts(client);
    },
  });
  const refresh = useMutation({
    mutationFn: alertsApi.refresh,
    onSuccess: async (r) => {
      toast.success(
        r.opened || r.resolved
          ? `Checked: ${r.opened} new, ${r.resolved} resolved`
          : 'Checked: nothing has changed',
      );
      await invalidateAlerts(client);
    },
  });
  const unread = summary.data?.unread ?? 0;

  return (
    <div className="space-y-4">
      <PageIntro description="Raised automatically every few minutes from stock and expiry. An alert closes by itself once it is dealt with (restocked, sold through, written off); marking it seen only clears the badge, for everyone." />

      <ListToolbar
        actions={
          canManage && (
            <>
              <Button
                variant="outline"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
              >
                <RefreshCwIcon className={refresh.isPending ? 'animate-spin' : undefined} /> Check
                now
              </Button>
              <Button
                variant="outline"
                onClick={() => acknowledgeAll.mutate()}
                disabled={acknowledgeAll.isPending || unread === 0}
              >
                <CheckCheckIcon /> Mark all seen
              </Button>
            </>
          )
        }
      >
        <NativeSelect
          value={state}
          onChange={(e) => update({ state: e.target.value })}
          aria-label="Show"
          className="w-full sm:w-40"
        >
          {ALERT_STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABELS[s]}
              {s === 'unread' && summary.data ? ` (${summary.data.unread})` : ''}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          value={type ?? ''}
          onChange={(e) => update({ type: e.target.value })}
          aria-label="Type"
          className="w-full sm:w-44"
        >
          <option value="">All types</option>
          {ALERT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ALERT_TYPE_LABELS[t]}
              {summary.data?.byType[t] ? ` (${summary.data.byType[t]} unread)` : ''}
            </option>
          ))}
        </NativeSelect>
      </ListToolbar>

      <ListView
        query={alerts}
        filtered={!!type || state === 'unread' || state === 'resolved'}
        onClearFilters={() => update({ type: '', state: '' })}
        onFirstPage={() => update({ page: 1 })}
        columns={3}
        empty={
          <EmptyState
            icon={BellOffIcon}
            title="No alerts"
            description="Nothing is low on stock or close to expiry right now."
          />
        }
      >
        {(data) => (
          <div className="space-y-3">
            <div className="divide-y rounded-lg border bg-card">
              {data.items.map((alert) => (
                <AlertRow key={alert.id} alert={alert} canAcknowledge={canManage} />
              ))}
            </div>
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={(page) => update({ page })}
              onPageSizeChange={(pageSize) => update({ pageSize })}
            />
          </div>
        )}
      </ListView>
    </div>
  );
}
