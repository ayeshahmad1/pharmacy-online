// Which alerts should be open right now, from current stock. Pure, so the
// rules can be unit-tested without a database; alerts.service.ts reads the
// stock and reconciles the Alert table against this list.

import type { AlertDetails, AlertSeverity, AlertType } from '@pharmacy/shared';
import { isExpiredOn } from '../../lib/dates';

/** An active medicine at or below its reorder level that has been stocked before. */
export type LowStockRow = {
  medicineId: string;
  name: string;
  unit: string;
  reorderLevel: number;
  sellable: number;
  expired: number;
};

/** A batch with stock that is expired or expires within the alert window. */
export type ExpiringBatchRow = {
  batchId: string;
  batchNumber: string;
  /** "YYYY-MM-DD" */
  expiryDate: string;
  medicineId: string;
  name: string;
  unit: string;
  quantity: number;
};

export type AlertCondition = {
  /** Unique per condition; becomes Alert.openKey while the alert is unresolved. */
  key: string;
  type: AlertType;
  severity: AlertSeverity;
  medicineId: string;
  batchId: string | null;
  message: string;
  details: AlertDetails;
};

/** 1 tablet, 2 tablets, 3 ml. Units are stored lowercase and singular. */
export function quantityText(quantity: number, unit: string): string {
  const plural = quantity !== 1 && !unit.endsWith('s') && unit.length > 2;
  return `${quantity.toLocaleString('en-US')} ${plural ? `${unit}s` : unit}`;
}

export function stockCondition(row: LowStockRow): AlertCondition {
  const out = row.sellable <= 0;
  const type: AlertType = out ? 'OUT_OF_STOCK' : 'LOW_STOCK';
  const shelf =
    row.expired > 0 ? ` (${quantityText(row.expired, row.unit)} expired on the shelf)` : '';
  const message = out
    ? `${row.name} is out of stock${shelf}`
    : `${row.name} is running low: ${quantityText(row.sellable, row.unit)} left, reorder level ${row.reorderLevel}${shelf}`;
  return {
    key: `${type}:${row.medicineId}`,
    type,
    severity: out ? 'CRITICAL' : 'WARNING',
    medicineId: row.medicineId,
    batchId: null,
    message,
    details: {
      quantity: Math.max(row.sellable, 0),
      unit: row.unit,
      reorderLevel: row.reorderLevel,
      expiredQuantity: row.expired,
    },
  };
}

export function expiryCondition(row: ExpiringBatchRow, today: string): AlertCondition {
  const expired = isExpiredOn(row.expiryDate, today);
  const type: AlertType = expired ? 'EXPIRED' : 'EXPIRING_SOON';
  const stock = quantityText(row.quantity, row.unit);
  const message = expired
    ? `${row.name} batch ${row.batchNumber} expired on ${row.expiryDate} with ${stock} still in stock; write it off`
    : `${row.name} batch ${row.batchNumber} expires on ${row.expiryDate}: ${stock} in stock`;
  return {
    key: `${type}:${row.batchId}`,
    type,
    severity: expired ? 'CRITICAL' : 'WARNING',
    medicineId: row.medicineId,
    batchId: row.batchId,
    message,
    details: { quantity: row.quantity, unit: row.unit, expiryDate: row.expiryDate },
  };
}

export function alertConditions(
  lowStock: LowStockRow[],
  batches: ExpiringBatchRow[],
  today: string,
): AlertCondition[] {
  return [...lowStock.map(stockCondition), ...batches.map((b) => expiryCondition(b, today))];
}

/** Same JSON regardless of key order (Postgres jsonb reorders keys). */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type OpenAlert = {
  id: string;
  openKey: string;
  severity: AlertSeverity;
  message: string;
  details: unknown;
};

/**
 * What to do to the open alerts so they match the current conditions: open
 * new ones, refresh changed ones, resolve the ones whose condition is gone.
 */
export function reconcile(open: OpenAlert[], conditions: AlertCondition[]) {
  const openByKey = new Map(open.map((a) => [a.openKey, a]));
  const keys = new Set(conditions.map((c) => c.key));
  const toOpen: AlertCondition[] = [];
  const toUpdate: { id: string; condition: AlertCondition }[] = [];
  for (const condition of conditions) {
    const existing = openByKey.get(condition.key);
    if (!existing) toOpen.push(condition);
    else if (
      existing.message !== condition.message ||
      existing.severity !== condition.severity ||
      !sameJson(existing.details, condition.details)
    ) {
      toUpdate.push({ id: existing.id, condition });
    }
  }
  const toResolve = open.filter((a) => !keys.has(a.openKey)).map((a) => a.id);
  return { toOpen, toUpdate, toResolve };
}
