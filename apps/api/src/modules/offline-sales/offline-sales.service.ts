import {
  createSaleBodySchema,
  type CreateSaleBody,
  type DismissOfflineConflictBody,
  type ListOfflineConflictsQuery,
  type OfflineSaleConflictDto,
  type Paginated,
  type ReportOfflineConflictBody,
  type RetryOfflineConflictBody,
  type RoleCode,
} from '@pharmacy/shared';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { AppError, conflict, idempotencyKeyReused, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { type CreateSaleResult, type Seller, createSale, userRef } from '../sales/sales.service';

// Offline sales the API refused when a counter synced them. The device
// reports each one here instead of dropping it; a pharmacist or admin then
// saves it (after fixing whatever stopped it) or dismisses it with a reason.

/** Cashiers only ever see the conflicts of their own sales (CLAUDE.md rule 9). */
export type Viewer = { id: string; role: RoleCode };
const seesAll = (viewer: Viewer) => viewer.role !== 'CASHIER';

const conflictInclude = {
  cashier: userRef,
  resolvedBy: userRef,
  sale: { select: { id: true, receiptNumber: true } },
} satisfies Prisma.OfflineSaleConflictInclude;

type ConflictRow = Prisma.OfflineSaleConflictGetPayload<{ include: typeof conflictInclude }>;
type MedicineNames = Map<string, { name: string; unit: string }>;

const requestOf = (row: { request: Prisma.JsonValue }) => row.request as CreateSaleBody;

async function medicineNames(rows: { request: Prisma.JsonValue }[]): Promise<MedicineNames> {
  const ids = [...new Set(rows.flatMap((r) => requestOf(r).items.map((i) => i.medicineId)))];
  const medicines = await prisma.medicine.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, unit: true },
  });
  return new Map(medicines.map((m) => [m.id, m]));
}

function toDto(row: ConflictRow, names: MedicineNames): OfflineSaleConflictDto {
  const request = requestOf(row);
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    cashier: row.cashier,
    soldAt: row.soldAt.toISOString(),
    expectedTotal: row.expectedTotal.toFixed(2),
    items: request.items.map((item) => ({
      medicineId: item.medicineId,
      name: names.get(item.medicineId)?.name ?? null,
      unit: names.get(item.medicineId)?.unit ?? null,
      quantity: item.quantity,
    })),
    request,
    error: { code: row.errorCode, message: row.errorMessage, details: row.errorDetails ?? null },
    attempts: row.attempts,
    reportedAt: row.createdAt.toISOString(),
    lastAttemptAt: row.lastAttemptAt.toISOString(),
    sale: row.sale,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    dismissReason: row.dismissReason,
  };
}

async function loadConflict(id: string): Promise<OfflineSaleConflictDto> {
  const row = await prisma.offlineSaleConflict.findUniqueOrThrow({
    where: { id },
    include: conflictInclude,
  });
  return toDto(row, await medicineNames([row]));
}

/** Locks the conflict until commit and checks it is still open. */
async function lockOpen(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status" FROM "OfflineSaleConflict" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (!row) throw notFound('Flagged sale not found');
  if (row.status !== 'OPEN') {
    throw conflict(`This flagged sale is already ${row.status.toLowerCase()}`);
  }
}

const jsonOrNull = (value: unknown) =>
  value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

// ─── Report ─────────────────────────────────────────────────────────────────

export type ReportResult = { conflict: OfflineSaleConflictDto; created: boolean };

/**
 * Records an offline sale the API refused at sync, for the cashier who made
 * it (the reporter). Reporting the same sale again returns the first record,
 * so a device that lost the reply can safely report again.
 */
export async function reportConflict(
  input: ReportOfflineConflictBody,
  reporter: Actor,
): Promise<ReportResult> {
  const { sale: request, error } = input;
  const key = request.idempotencyKey;

  const existing = await prisma.offlineSaleConflict.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, cashierId: true },
  });
  if (existing) {
    if (existing.cashierId !== reporter.id) {
      throw idempotencyKeyReused('This sale was reported by another user');
    }
    return { conflict: await loadConflict(existing.id), created: false };
  }
  const sale = await prisma.sale.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, receiptNumber: true },
  });
  if (sale) {
    // It was saved after all (e.g. by an earlier attempt whose reply was lost).
    throw conflict(`This sale was already saved as ${sale.receiptNumber}`, { sale });
  }

  try {
    const id = await prisma.$transaction(async (tx) => {
      const row = await tx.offlineSaleConflict.create({
        data: {
          idempotencyKey: key,
          cashierId: reporter.id,
          request: request,
          soldAt: new Date(request.offline!.soldAt),
          expectedTotal: request.offline!.expectedTotal,
          errorCode: error.code,
          errorMessage: error.message,
          errorDetails: jsonOrNull(error.details),
        },
        select: { id: true },
      });
      await writeAudit(tx, {
        userId: reporter.id,
        action: 'OFFLINE_SALE_REPORT',
        entityType: 'OfflineSaleConflict',
        entityId: row.id,
        after: {
          idempotencyKey: key,
          soldAt: request.offline!.soldAt,
          expectedTotal: request.offline!.expectedTotal,
          error: { code: error.code, message: error.message },
        },
        meta: reporter.meta,
      });
      return row.id;
    });
    return { conflict: await loadConflict(id), created: true };
  } catch (err) {
    // Two reports of the same sale raced; the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return reportConflict(input, reporter);
    }
    throw err;
  }
}

// ─── Review ─────────────────────────────────────────────────────────────────

/**
 * Saves a flagged sale as it was recorded at the counter: for its original
 * cashier and time, under its original idempotency key. The reviewer's
 * approval lifts the cashier discount cap; `acceptCurrentPrices` charges
 * today's catalogue prices. If the API still refuses it, the conflict stays
 * open with the new reason and the error is passed on.
 */
export async function retryConflict(
  id: string,
  input: RetryOfflineConflictBody,
  reviewer: Seller,
): Promise<OfflineSaleConflictDto> {
  const row = await prisma.offlineSaleConflict.findUnique({
    where: { id },
    include: { cashier: { select: { id: true, role: { select: { code: true } } } } },
  });
  if (!row) throw notFound('Flagged sale not found');
  if (row.status !== 'OPEN') {
    throw conflict(`This flagged sale is already ${row.status.toLowerCase()}`);
  }

  // Parsed again so the cart hashes exactly as it did when the device sent it.
  const request = createSaleBodySchema.parse(row.request);
  const seller: Seller = { id: row.cashierId, role: row.cashier.role.code, meta: reviewer.meta };
  const resolve = async (tx: Prisma.TransactionClient, sale: { id: string }) => {
    await lockOpen(tx, id);
    await tx.offlineSaleConflict.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        saleId: sale.id,
        resolvedById: reviewer.id,
        resolvedAt: new Date(),
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    await writeAudit(tx, {
      userId: reviewer.id,
      action: 'OFFLINE_SALE_RETRY',
      entityType: 'OfflineSaleConflict',
      entityId: id,
      before: { status: 'OPEN', error: { code: row.errorCode, message: row.errorMessage } },
      after: {
        status: 'RESOLVED',
        saleId: sale.id,
        acceptCurrentPrices: input.acceptCurrentPrices,
      },
      meta: reviewer.meta,
    });
  };

  let result: CreateSaleResult;
  try {
    result = await createSale(request, seller, {
      review: { by: reviewer, acceptCurrentPrices: input.acceptCurrentPrices },
      onCreated: resolve,
    });
  } catch (err) {
    if (err instanceof AppError && err.status < 500) await recordFailedRetry(id, err, reviewer);
    throw err;
  }
  // Saved before (a sale with this key exists): link it rather than sell again.
  if (result.replayed) await prisma.$transaction((tx) => resolve(tx, result.sale));
  return loadConflict(id);
}

async function recordFailedRetry(id: string, err: AppError, reviewer: Actor) {
  await prisma.$transaction(async (tx) => {
    await lockOpen(tx, id);
    await tx.offlineSaleConflict.update({
      where: { id },
      data: {
        errorCode: err.code,
        errorMessage: err.message,
        errorDetails: jsonOrNull(err.details),
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    await writeAudit(tx, {
      userId: reviewer.id,
      action: 'OFFLINE_SALE_RETRY',
      entityType: 'OfflineSaleConflict',
      entityId: id,
      after: { status: 'OPEN', error: { code: err.code, message: err.message } },
      meta: reviewer.meta,
    });
  });
}

/** Closes a flagged sale without saving it, e.g. when it was handled by hand. */
export async function dismissConflict(
  id: string,
  input: DismissOfflineConflictBody,
  reviewer: Actor,
): Promise<OfflineSaleConflictDto> {
  await prisma.$transaction(async (tx) => {
    await lockOpen(tx, id);
    await tx.offlineSaleConflict.update({
      where: { id },
      data: {
        status: 'DISMISSED',
        resolvedById: reviewer.id,
        resolvedAt: new Date(),
        dismissReason: input.reason,
      },
    });
    await writeAudit(tx, {
      userId: reviewer.id,
      action: 'OFFLINE_SALE_DISMISS',
      entityType: 'OfflineSaleConflict',
      entityId: id,
      before: { status: 'OPEN' },
      after: { status: 'DISMISSED', reason: input.reason },
      meta: reviewer.meta,
    });
  });
  return loadConflict(id);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getConflict(id: string, viewer: Viewer): Promise<OfflineSaleConflictDto> {
  const row = await prisma.offlineSaleConflict.findUnique({
    where: { id },
    include: conflictInclude,
  });
  // A cashier gets 404, not 403, for someone else's: no hint that it exists.
  if (!row || (!seesAll(viewer) && row.cashierId !== viewer.id)) {
    throw notFound('Flagged sale not found');
  }
  return toDto(row, await medicineNames([row]));
}

/** Newest first. Cashiers only see their own. */
export async function listConflicts(
  query: ListOfflineConflictsQuery,
  viewer: Viewer,
): Promise<Paginated<OfflineSaleConflictDto>> {
  const where: Prisma.OfflineSaleConflictWhereInput = {
    status: query.status,
    ...(!seesAll(viewer) && { cashierId: viewer.id }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.offlineSaleConflict.count({ where }),
    prisma.offlineSaleConflict.findMany({
      where,
      include: conflictInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  const names = await medicineNames(rows);
  return {
    items: rows.map((r) => toDto(r, names)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
