import {
  ALERT_TYPES,
  type AcknowledgeAlertsBody,
  type AlertDetails,
  type AlertDto,
  type AlertRefreshDto,
  type AlertSummaryDto,
  type AlertType,
  type ListAlertsQuery,
  type Paginated,
} from '@pharmacy/shared';
import type { Prisma } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { config } from '../../lib/config';
import { addDays, businessToday, toDateOnly } from '../../lib/dates';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { batchQuantitySql, medicineStockTotalsSql } from '../../lib/stock';
import { userRef } from '../sales/sales.service';
import {
  type ExpiringBatchRow,
  type LowStockRow,
  type OpenAlert,
  alertConditions,
  reconcile,
} from './alerts.rules';

const alertInclude = {
  medicine: { select: { id: true, name: true } },
  batch: { select: { id: true, batchNumber: true, expiryDate: true } },
  acknowledgedBy: userRef,
} satisfies Prisma.AlertInclude;

type AlertRow = Prisma.AlertGetPayload<{ include: typeof alertInclude }>;

function toAlertDto(a: AlertRow): AlertDto {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.resolvedAt ? 'RESOLVED' : a.acknowledgedAt ? 'ACKNOWLEDGED' : 'OPEN',
    message: a.message,
    medicine: a.medicine,
    batch: a.batch
      ? {
          id: a.batch.id,
          batchNumber: a.batch.batchNumber,
          expiryDate: toDateOnly(a.batch.expiryDate),
        }
      : null,
    details: a.details as AlertDetails,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: a.acknowledgedBy,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
  };
}

// ─── The alerts job ─────────────────────────────────────────────────────────

async function lowStockRows(tx: Prisma.TransactionClient, today: string) {
  // Only medicines stocked at some point: a catalogue entry never received
  // is not "out of stock" in a way anyone needs telling about.
  return tx.$queryRaw<LowStockRow[]>`
    SELECT m."id" AS "medicineId", m."name", m."unit", m."reorderLevel", s."sellable", s."expired"
    FROM "Medicine" m
    CROSS JOIN LATERAL (${medicineStockTotalsSql(today)}) s
    WHERE m."status" = 'ACTIVE' AND s."sellable" <= m."reorderLevel"
      AND EXISTS (SELECT 1 FROM "Batch" b WHERE b."medicineId" = m."id")`;
}

async function expiringBatchRows(tx: Prisma.TransactionClient, today: string) {
  const until = addDays(today, config.ALERT_EXPIRY_DAYS);
  const rows = await tx.$queryRaw<(Omit<ExpiringBatchRow, 'expiryDate'> & { expiryDate: Date })[]>`
    SELECT b."id" AS "batchId", b."batchNumber", b."expiryDate", m."id" AS "medicineId",
      m."name", m."unit", q."qty" AS "quantity"
    FROM "Batch" b
    CROSS JOIN LATERAL (SELECT ${batchQuantitySql} AS "qty") q
    JOIN "Medicine" m ON m."id" = b."medicineId"
    WHERE b."expiryDate" <= ${until}::date AND q."qty" > 0`;
  return rows.map((r) => ({ ...r, expiryDate: toDateOnly(r.expiryDate) }));
}

/**
 * Brings the Alert table in line with current stock: opens an alert for each
 * new condition, refreshes the numbers on open ones, and resolves those whose
 * condition has gone. Runs in one transaction under an advisory lock, so two
 * runs (two API processes, or the cron job and "check now") never race;
 * returns null if another run holds the lock.
 */
export async function refreshAlerts(
  actor: Actor | null = null,
  now = new Date(),
): Promise<AlertRefreshDto | null> {
  const today = businessToday(now);
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<[{ locked: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtext('pharmacy-pos:alerts')) AS "locked"`;
      if (!locked) return null;

      const conditions = alertConditions(
        await lowStockRows(tx, today),
        await expiringBatchRows(tx, today),
        today,
      );
      const open = (await tx.alert.findMany({
        where: { resolvedAt: null },
        select: { id: true, openKey: true, severity: true, message: true, details: true },
      })) as OpenAlert[];
      const { toOpen, toUpdate, toResolve } = reconcile(open, conditions);

      if (toOpen.length > 0) {
        await tx.alert.createMany({
          data: toOpen.map((c) => ({
            type: c.type,
            severity: c.severity,
            openKey: c.key,
            medicineId: c.medicineId,
            batchId: c.batchId,
            message: c.message,
            details: c.details,
          })),
        });
      }
      for (const { id, condition } of toUpdate) {
        await tx.alert.update({
          where: { id },
          data: {
            severity: condition.severity,
            message: condition.message,
            details: condition.details,
          },
        });
      }
      if (toResolve.length > 0) {
        await tx.alert.updateMany({
          where: { id: { in: toResolve } },
          data: { resolvedAt: now, openKey: null },
        });
      }

      const result = {
        opened: toOpen.length,
        updated: toUpdate.length,
        resolved: toResolve.length,
        active: conditions.length,
      };
      if (result.opened + result.updated + result.resolved > 0) {
        await writeAudit(tx, {
          userId: actor?.id ?? null,
          action: 'ALERTS_REFRESH',
          entityType: 'Alert',
          after: { ...result, openedKeys: toOpen.map((c) => c.key), resolvedIds: toResolve },
          meta: actor?.meta,
        });
      }
      return result;
    },
    { timeout: 60_000 },
  );
}

/** "Check now" from the app. */
export async function refreshAlertsNow(actor: Actor): Promise<AlertRefreshDto> {
  const result = await refreshAlerts(actor);
  if (!result) throw conflict('An alerts check is already running; try again in a moment');
  return result;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

const UNREAD = { resolvedAt: null, acknowledgedAt: null } satisfies Prisma.AlertWhereInput;

export async function listAlerts(query: ListAlertsQuery): Promise<Paginated<AlertDto>> {
  const where: Prisma.AlertWhereInput = {
    type: query.type,
    ...(query.state === 'unread' && UNREAD),
    ...(query.state === 'active' && { resolvedAt: null }),
    ...(query.state === 'resolved' && { resolvedAt: { not: null } }),
  };
  const orderBy: Prisma.AlertOrderByWithRelationInput[] =
    query.state === 'resolved'
      ? [{ resolvedAt: 'desc' }, { id: 'desc' }]
      : // Unread first, then critical before warning, newest first.
        [
          { acknowledgedAt: { sort: 'desc', nulls: 'first' } },
          { severity: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ];
  const [total, rows] = await prisma.$transaction([
    prisma.alert.count({ where }),
    prisma.alert.findMany({
      where,
      include: alertInclude,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return { items: rows.map(toAlertDto), total, page: query.page, pageSize: query.pageSize };
}

export async function alertSummary(): Promise<AlertSummaryDto> {
  const [active, unreadByType] = await prisma.$transaction([
    prisma.alert.count({ where: { resolvedAt: null } }),
    prisma.alert.groupBy({
      by: ['type'],
      where: UNREAD,
      orderBy: { type: 'asc' },
      _count: { _all: true },
    }),
  ]);
  const byType = Object.fromEntries(ALERT_TYPES.map((t) => [t, 0])) as Record<AlertType, number>;
  for (const row of unreadByType) {
    byType[row.type] = (row._count as { _all: number })._all;
  }
  return {
    unread: Object.values(byType).reduce((a, n) => a + n, 0),
    active,
    byType,
  };
}

// ─── Acknowledge ────────────────────────────────────────────────────────────

/** Takes an alert off the badge for everyone. Acknowledging twice changes nothing. */
export async function acknowledgeAlert(id: string, actor: Actor): Promise<AlertDto> {
  return prisma.$transaction(async (tx) => {
    const alert = await tx.alert.findUnique({ where: { id }, include: alertInclude });
    if (!alert) throw notFound('Alert not found');
    if (alert.acknowledgedAt) return toAlertDto(alert);

    const updated = await tx.alert.update({
      where: { id },
      data: { acknowledgedAt: new Date(), acknowledgedById: actor.id },
      include: alertInclude,
    });
    await writeAudit(tx, {
      userId: actor.id,
      action: 'ALERT_ACKNOWLEDGE',
      entityType: 'Alert',
      entityId: id,
      before: { acknowledgedAt: null },
      after: { acknowledgedAt: updated.acknowledgedAt, type: alert.type, message: alert.message },
      meta: actor.meta,
    });
    return toAlertDto(updated);
  });
}

export async function acknowledgeAlerts(
  input: AcknowledgeAlertsBody,
  actor: Actor,
): Promise<{ acknowledged: number }> {
  return prisma.$transaction(async (tx) => {
    const where = { ...UNREAD, type: input.type };
    const ids = (await tx.alert.findMany({ where, select: { id: true } })).map((a) => a.id);
    if (ids.length === 0) return { acknowledged: 0 };

    const now = new Date();
    const { count } = await tx.alert.updateMany({
      where: { id: { in: ids }, acknowledgedAt: null },
      data: { acknowledgedAt: now, acknowledgedById: actor.id },
    });
    await writeAudit(tx, {
      userId: actor.id,
      action: 'ALERT_ACKNOWLEDGE',
      entityType: 'Alert',
      after: { acknowledgedAt: now, type: input.type ?? 'ALL', ids },
      meta: actor.meta,
    });
    return { acknowledged: count };
  });
}
