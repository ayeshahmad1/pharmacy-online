import { z } from 'zod';
import type { AlertSeverity, AlertType } from '../constants';
import { ALERT_TYPES } from '../constants';
import { paginationQuerySchema } from './common';
import type { SaleUserRef } from './sales';

// Low-stock and expiry alerts, raised by the alerts job on the API. An alert
// stays open while its condition holds and resolves by itself once it is
// gone (restocked, sold through, written off). Acknowledging only takes it
// off everyone's badge.

/**
 * - `unread`: open and not acknowledged (what the badge counts)
 * - `active`: still open, acknowledged or not (default)
 * - `resolved`: the condition has gone away
 */
export const ALERT_STATES = ['unread', 'active', 'resolved', 'all'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const listAlertsQuerySchema = paginationQuerySchema.extend({
  state: z.enum(ALERT_STATES).default('active'),
  type: z.enum(ALERT_TYPES).optional(),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

/** Acknowledges every unread alert, or only those of one type. */
export const acknowledgeAlertsBodySchema = z.strictObject({
  type: z.enum(ALERT_TYPES).optional(),
});
export type AcknowledgeAlertsBody = z.infer<typeof acknowledgeAlertsBodySchema>;

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export type AlertDetails = {
  /** Sellable units (stock alerts) or units in the batch (expiry alerts). */
  quantity: number;
  unit: string;
  reorderLevel?: number;
  /** Expired units still on the shelf (stock alerts). */
  expiredQuantity?: number;
  expiryDate?: string;
};

export type AlertDto = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  medicine: { id: string; name: string };
  batch: { id: string; batchNumber: string; expiryDate: string } | null;
  details: AlertDetails;
  /** When the condition was first seen. */
  createdAt: string;
  /** When the alerts job last refreshed it. */
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: SaleUserRef | null;
  resolvedAt: string | null;
};

export type AlertSummaryDto = {
  /** Open and not acknowledged: the badge number. */
  unread: number;
  /** Open, acknowledged or not. */
  active: number;
  /** Unread alerts by type. */
  byType: Record<AlertType, number>;
};

export type AlertRefreshDto = { opened: number; updated: number; resolved: number; active: number };
