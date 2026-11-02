// The old system's deliveries and returns (CLAUDE.md rule 15), loaded by the
// Mongo migration. Read-only: they never moved stock here, and no report,
// dashboard or cash closing reads these tables.

import type {
  LegacyBatchRef,
  LegacyPurchaseDto,
  LegacyReturnDto,
  ListLegacyPurchasesQuery,
  ListLegacyReturnsQuery,
  Paginated,
} from '@pharmacy/shared';
import type { Prisma } from '@prisma/client';
import { addDays, startOfBusinessDay, toDateOnly } from '../../lib/dates';
import { formatPaisa, toPaisa } from '../../lib/money';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';
import { userRef } from '../sales/sales.service';

const batchInclude = {
  select: {
    id: true,
    batchNumber: true,
    expiryDate: true,
    medicine: { select: { id: true, name: true, genericName: true, unit: true } },
  },
} satisfies Prisma.BatchDefaultArgs;

type BatchRow = Prisma.BatchGetPayload<typeof batchInclude>;

const batchRef = (b: BatchRow): LegacyBatchRef => ({
  id: b.id,
  batchNumber: b.batchNumber,
  expiryDate: toDateOnly(b.expiryDate),
});

/** Days in the pharmacy's timezone, inclusive, as a timestamp filter. */
function dayRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from && { gte: startOfBusinessDay(from) }),
    ...(to && { lt: startOfBusinessDay(addDays(to, 1)) }),
  };
}

/** Batches of the given medicine, or of medicines whose name or generic name matches. */
function batchFilter(query: { q?: string; medicineId?: string }): Prisma.BatchWhereInput {
  const contains = query.q && { contains: escapeLike(query.q), mode: 'insensitive' as const };
  return {
    medicineId: query.medicineId,
    ...(contains && { medicine: { OR: [{ name: contains }, { genericName: contains }] } }),
  };
}

/** Half-up, to the paisa. */
function perUnit(total: Prisma.Decimal, quantity: number): string {
  const q = BigInt(quantity);
  return formatPaisa((2n * toPaisa(total) + q) / (2n * q));
}

const purchaseInclude = {
  batch: batchInclude,
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.LegacyPurchaseInclude;

export async function listPurchases(
  query: ListLegacyPurchasesQuery,
): Promise<Paginated<LegacyPurchaseDto>> {
  const where: Prisma.LegacyPurchaseWhereInput = {
    supplierId: query.supplierId,
    batch: batchFilter(query),
    purchasedAt: dayRange(query.from, query.to),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.legacyPurchase.count({ where }),
    prisma.legacyPurchase.findMany({
      where,
      include: purchaseInclude,
      orderBy: [{ purchasedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    items: rows.map((p) => ({
      id: p.id,
      purchasedAt: p.purchasedAt.toISOString(),
      medicine: p.batch.medicine,
      batch: batchRef(p.batch),
      supplier: p.supplier,
      quantity: p.quantity,
      totalCost: p.totalCost === null ? null : formatPaisa(toPaisa(p.totalCost)),
      unitCost: p.totalCost === null ? null : perUnit(p.totalCost, p.quantity),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

const returnInclude = {
  cashier: userRef,
  items: { include: { batch: batchInclude }, orderBy: { lineNo: 'asc' } },
} satisfies Prisma.LegacyReturnInclude;

export async function listReturns(
  query: ListLegacyReturnsQuery,
): Promise<Paginated<LegacyReturnDto>> {
  const lines = batchFilter(query);
  const where: Prisma.LegacyReturnWhereInput = {
    cashierId: query.cashierId,
    returnedAt: dayRange(query.from, query.to),
    ...((query.q || query.medicineId) && { items: { some: { batch: lines } } }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.legacyReturn.count({ where }),
    prisma.legacyReturn.findMany({
      where,
      include: returnInclude,
      orderBy: [{ returnedAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      returnedAt: r.returnedAt.toISOString(),
      cashier: r.cashier,
      refundTotal: formatPaisa(toPaisa(r.refundTotal)),
      itemCount: r.items.reduce((n, i) => n + i.quantity, 0),
      items: r.items.map((i) => ({
        lineNo: i.lineNo,
        medicine: i.batch.medicine,
        batch: batchRef(i.batch),
        quantity: i.quantity,
        unitPrice: formatPaisa(toPaisa(i.unitPrice)),
        discount: formatPaisa(toPaisa(i.discount)),
        lineTotal: formatPaisa(toPaisa(i.lineTotal)),
      })),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
