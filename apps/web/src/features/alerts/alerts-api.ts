import type {
  AcknowledgeAlertsBody,
  AlertDto,
  AlertRefreshDto,
  AlertSeverity,
  AlertSummaryDto,
  AlertType,
  ListAlertsQuery,
  Paginated,
} from '@pharmacy/shared';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  CalendarXIcon,
  PackageMinusIcon,
  PackageXIcon,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { Tone } from '@/lib/stock-status';
import { useOffline } from '@/offline/offline-context';

export const alertKeys = {
  all: ['alerts'] as const,
  summary: ['alerts', 'summary'] as const,
  list: (query: object) => ['alerts', 'list', query] as const,
};

export const alertsApi = {
  summary: (signal?: AbortSignal) => api.get<AlertSummaryDto>('/alerts/summary', {}, signal),
  list: (query: Partial<ListAlertsQuery>, signal?: AbortSignal) =>
    api.get<Paginated<AlertDto>>('/alerts', query, signal),
  acknowledge: async (id: string) =>
    (await api.post<{ alert: AlertDto }>(`/alerts/${id}/acknowledge`, {})).alert,
  acknowledgeAll: (body: AcknowledgeAlertsBody) =>
    api.post<{ acknowledged: number }>('/alerts/acknowledge', body),
  refresh: () => api.post<AlertRefreshDto>('/alerts/refresh', {}),
};

export function invalidateAlerts(client: QueryClient) {
  return client.invalidateQueries({ queryKey: alertKeys.all });
}

/** How often the badge re-checks. The API's job refreshes alerts every 15 minutes. */
const POLL_MS = 60_000;

/** The badge count, polled while the server is reachable. */
export function useAlertSummary() {
  const { online } = useOffline();
  return useQuery({
    queryKey: alertKeys.summary,
    queryFn: ({ signal }) => alertsApi.summary(signal),
    refetchInterval: online ? POLL_MS : false,
    enabled: online,
  });
}

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  OUT_OF_STOCK: 'Out of stock',
  LOW_STOCK: 'Low stock',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Expired on shelf',
};

export const ALERT_TYPE_ICONS: Record<AlertType, LucideIcon> = {
  OUT_OF_STOCK: PackageXIcon,
  LOW_STOCK: PackageMinusIcon,
  EXPIRING_SOON: CalendarClockIcon,
  EXPIRED: CalendarXIcon,
};

export const severityTone = (severity: AlertSeverity): Tone =>
  severity === 'CRITICAL' ? 'danger' : 'warning';

/** Where to act on an alert: the medicine, or the expired list to write it off. */
export function alertLink(alert: AlertDto): string {
  if (alert.type === 'EXPIRED') return '/inventory?view=expired';
  return `/medicines/${alert.medicine.id}`;
}
