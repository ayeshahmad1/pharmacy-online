import {
  type CreateReturnBody,
  type ListReturnsQuery,
  PAYMENT_METHODS,
  type Paginated,
  type PaymentMethod,
  type RejectReturnBody,
  type ReturnDto,
  type ReturnSummaryDto,
  type ReturnableQuery,
  type ReturnableSaleDto,
  type RoleCode,
} from '@pharmacy/shared';
import type { Prisma } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import {
  addDays,
  businessToday,
  isExpiredOn,
  startOfBusinessDay,
  toDateOnly,
} from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { type Paisa, formatPaisa, sumPaisa, toPaisa } from '../../lib/money';
import { prisma } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/receipts';
import { escapeLike } from '../../lib/search';
import { saleItemInclude, toSaleItemDto, userRef } from '../sales/sales.service';
import { type RefundCapacity, lineRefund, planRefunds } from './returns.calc';

/** The signed-in user; the role decides whether a return needs approval. */
export type Staff = Actor & { role: RoleCode };
/** Who is reading: cashiers only see the returns they requested (CLAUDE.md rule 9). */
export type Viewer = { id: string; role: RoleCode };
const isApprover = (role: RoleCode) => role !== 'CASHIER';

/** Returns that hold on to the units and money they cover. */
const LIVE_STATUSES = ['PENDING', 'COMPLETED'] as const;

const returnInclude = {
  sale: { select: { id: true, receiptNumber: true, soldAt: true } },
  requestedBy: userRef,
  reviewedBy: userRef,
  items: {
    include: { saleItem: { include: saleItemInclude } },
    orderBy: { saleItem: { lineNo: 'asc' } },
  },
  // One row per method; list in the enum's order (cash, card, wallet).
  refunds: { orderBy: { method: 'asc' } },
} satisfies Prisma.ReturnInclude;

type ReturnRow = Prisma.ReturnGetPayload<{ include: typeof returnInclude }>;

function toReturnDto(r: ReturnRow): ReturnDto {
  return {
    id: r.id,
    returnNumber: r.returnNumber,
    status: r.status,
    sale: { ...r.sale, soldAt: r.sale.soldAt.toISOString() },
    requestedBy: r.requestedBy,
    requestedAt: r.createdAt.toISOString(),
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    refundTotal: r.refundTotal.toFixed(2),
    itemCount: r.items.reduce((sum, i) => sum + i.quantity, 0),
    reason: r.reason,
    rejectionReason: r.rejectionReason,
    items: r.items.map((i) => {
      const line = toSaleItemDto(i.saleItem);
      return {
        id: i.id,
        saleItemId: i.saleItemId,
        medicine: line.medicine,
        batch: line.batch,
        quantity: i.quantity,
        restock: i.restock,
        refundAmount: i.refundAmount.toFixed(2),
      };
    }),
    refunds: r.refunds.map((f) => ({
      id: f.id,
      method: f.method,
      amount: f.amount.toFixed(2),
      reference: f.reference,
    })),
  };
}

async function loadReturn(id: string): Promise<ReturnDto> {
  return toReturnDto(
    await prisma.return.findUniqueOrThrow({ where: { id }, include: returnInclude }),
  );
}

// ─── What is left to return ─────────────────────────────────────────────────

type Db = typeof prisma | Prisma.TransactionClient;

type LineReservation = { completed: number; pending: number; refund: Paisa };

/**
 * Per sale line, the units on completed and pending returns and the refund
 * they carry; per method, what the sale can still refund.
 */
async function reservations(db: Db, saleId: string) {
  const live = { saleId, status: { in: [...LIVE_STATUSES] } };
  const [items, refunds, payments] = await Promise.all([
    db.returnItem.findMany({
      where: { return: live },
      select: {
        saleItemId: true,
        quantity: true,
        refundAmount: true,
        return: { select: { status: true } },
      },
    }),
    db.returnRefund.findMany({ where: { return: live }, select: { method: true, amount: true } }),
    db.payment.findMany({ where: { saleId }, select: { method: true, amount: true } }),
  ]);

  const lines = new Map<string, LineReservation>();
  for (const item of items) {
    const line = lines.get(item.saleItemId) ?? { completed: 0, pending: 0, refund: 0n };
    if (item.return.status === 'PENDING') line.pending += item.quantity;
    else line.completed += item.quantity;
    line.refund += toPaisa(item.refundAmount);
    lines.set(item.saleItemId, line);
  }

  const paid = new Map<PaymentMethod, Paisa>();
  for (const p of payments) paid.set(p.method, (paid.get(p.method) ?? 0n) + toPaisa(p.amount));
  const capacity: RefundCapacity = new Map(paid);
  for (const r of refunds)
    capacity.set(r.method, (capacity.get(r.method) ?? 0n) - toPaisa(r.amount));

  return {
    line: (saleItemId: string) => lines.get(saleItemId) ?? { completed: 0, pending: 0, refund: 0n },
    paid,
    capacity,
  };
}

/** Locks the sale row, so returns, approvals and voids of one sale run one at a time. */
async function lockSale(tx: Prisma.TransactionClient, saleId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Sale" WHERE "id" = ${saleId}::uuid FOR UPDATE`;
  return locked.length > 0;
}

// ─── Create ─────────────────────────────────────────────────────────────────

/**
 * Records a return against a sale in one transaction (CLAUDE.md rule 4).
 * Each line may only take back what was sold minus what earlier completed or
 * pending returns already cover, so the same units can never come back twice.
 * Refunds are worked out from what the customer paid for each line.
 *
 * A cashier's return is saved as PENDING: nothing moves until a pharmacist
 * or admin approves it. A pharmacist's or admin's return completes at once.
 */
export async function createReturn(input: CreateReturnBody, staff: Staff): Promise<ReturnDto> {
  const today = businessToday();

  const returnId = await prisma.$transaction(async (tx) => {
    if (!(await lockSale(tx, input.saleId))) throw notFound('Sale not found');
    const sale = await tx.sale.findUniqueOrThrow({
      where: { id: input.saleId },
      select: {
        id: true,
        receiptNumber: true,
        status: true,
        items: { select: { id: true, batchId: true, quantity: true, lineTotal: true } },
      },
    });
    if (sale.status === 'VOIDED') {
      throw conflict(`Sale ${sale.receiptNumber} is voided; nothing can be returned`);
    }
    if (sale.status === 'REFUNDED') {
      throw conflict(`Sale ${sale.receiptNumber} has already been returned in full`);
    }

    const saleItems = new Map(sale.items.map((i) => [i.id, i]));
    const unknown = input.items.flatMap((item, index) =>
      saleItems.has(item.saleItemId)
        ? []
        : [{ index, field: 'saleItemId', message: 'Not a line of this sale' }],
    );
    if (unknown.length > 0) throw badRequest('Some items are not on this sale', { items: unknown });

    const reserved = await reservations(tx, sale.id);
    const tooMany = input.items.flatMap((item, index) => {
      const sold = saleItems.get(item.saleItemId)!.quantity;
      const r = reserved.line(item.saleItemId);
      const returnable = sold - r.completed - r.pending;
      return item.quantity > returnable
        ? [
            {
              index,
              saleItemId: item.saleItemId,
              requested: item.quantity,
              sold,
              returned: r.completed,
              pending: r.pending,
              returnable,
            },
          ]
        : [];
    });
    if (tooMany.length > 0) {
      const [first] = tooMany;
      const message =
        tooMany.length === 1 && first
          ? `Only ${first.returnable} of ${first.sold} can still be returned on this line (${first.requested} requested)`
          : 'Some items are more than can still be returned';
      throw conflict(message, { items: tooMany });
    }

    const lines = input.items.map((item) => {
      const saleItem = saleItems.get(item.saleItemId)!;
      const r = reserved.line(item.saleItemId);
      const refund = lineRefund(
        {
          quantity: saleItem.quantity,
          lineTotal: toPaisa(saleItem.lineTotal),
          reservedQuantity: r.completed + r.pending,
          reservedRefund: r.refund,
        },
        item.quantity,
      );
      return { ...item, refund };
    });
    const refundTotal = sumPaisa(lines.map((l) => l.refund));
    const refunds = planRefunds(
      refundTotal,
      reserved.capacity,
      input.refunds?.map((r) => ({
        method: r.method,
        amount: toPaisa(r.amount),
        reference: r.reference ?? null,
      })),
    );

    const returnNumber = await nextDocumentNumber(tx, 'R', today);
    const approved = isApprover(staff.role);
    const now = new Date();
    const created = await tx.return.create({
      data: {
        returnNumber,
        saleId: sale.id,
        status: approved ? 'COMPLETED' : 'PENDING',
        requestedById: staff.id,
        reason: input.reason,
        refundTotal: formatPaisa(refundTotal),
        ...(approved && { reviewedById: staff.id, reviewedAt: now }),
        items: {
          create: lines.map((l) => ({
            saleItemId: l.saleItemId,
            quantity: l.quantity,
            refundAmount: formatPaisa(l.refund),
            restock: l.restock,
          })),
        },
        refunds: {
          create: refunds.map((r) => ({
            method: r.method,
            amount: formatPaisa(r.amount),
            reference: r.reference,
          })),
        },
      },
      select: { id: true },
    });
    const effects = approved ? await applyReturn(tx, created.id, staff, today) : null;

    await writeAudit(tx, {
      userId: staff.id,
      action: 'RETURN_CREATE',
      entityType: 'Return',
      entityId: created.id,
      after: {
        returnNumber,
        saleId: sale.id,
        receiptNumber: sale.receiptNumber,
        status: approved ? 'COMPLETED' : 'PENDING',
        reason: input.reason,
        refundTotal: formatPaisa(refundTotal),
        items: lines.map((l) => ({
          saleItemId: l.saleItemId,
          batchId: saleItems.get(l.saleItemId)!.batchId,
          quantity: l.quantity,
          restockRequested: l.restock,
          refundAmount: formatPaisa(l.refund),
        })),
        refunds: refunds.map((r) => ({ method: r.method, amount: formatPaisa(r.amount) })),
        ...effects,
      },
      meta: staff.meta,
    });
    return created.id;
  });

  return loadReturn(returnId);
}

/**
 * Carries out a return that has just become COMPLETED: restockable units go
 * back to the batch they were sold from as RETURN movements (rule 5), units
 * from a batch that has expired since are kept out of stock (rule 2), and a
 * sale whose every unit has now come back becomes REFUNDED.
 */
async function applyReturn(
  tx: Prisma.TransactionClient,
  returnId: string,
  actor: Actor,
  today: string,
) {
  const ret = await tx.return.findUniqueOrThrow({
    where: { id: returnId },
    select: {
      returnNumber: true,
      reason: true,
      saleId: true,
      items: {
        select: {
          id: true,
          quantity: true,
          restock: true,
          saleItem: { select: { batchId: true, batch: { select: { expiryDate: true } } } },
        },
      },
    },
  });

  const expired = ret.items.filter(
    (i) => i.restock && isExpiredOn(toDateOnly(i.saleItem.batch.expiryDate), today),
  );
  if (expired.length > 0) {
    await tx.returnItem.updateMany({
      where: { id: { in: expired.map((i) => i.id) } },
      data: { restock: false },
    });
  }
  const expiredIds = new Set(expired.map((i) => i.id));
  const restocked = ret.items.filter((i) => i.restock && !expiredIds.has(i.id));
  if (restocked.length > 0) {
    await tx.stockMovement.createMany({
      data: restocked.map((i) => ({
        batchId: i.saleItem.batchId,
        type: 'RETURN' as const,
        quantity: i.quantity,
        reason: `Return ${ret.returnNumber}: ${ret.reason}`,
        userId: actor.id,
        returnItemId: i.id,
      })),
    });
  }

  // The sale is locked by the caller, so this count is final.
  const sale = await tx.sale.findUniqueOrThrow({
    where: { id: ret.saleId },
    select: { status: true, items: { select: { id: true, quantity: true } } },
  });
  const returned = await tx.returnItem.groupBy({
    by: ['saleItemId'],
    where: { return: { saleId: ret.saleId, status: 'COMPLETED' } },
    _sum: { quantity: true },
  });
  const returnedBy = new Map(returned.map((r) => [r.saleItemId, r._sum.quantity ?? 0]));
  const fullyReturned = sale.items.every((i) => returnedBy.get(i.id) === i.quantity);
  if (fullyReturned) {
    await tx.sale.update({ where: { id: ret.saleId }, data: { status: 'REFUNDED' } });
  }

  const ref = (i: (typeof ret.items)[number]) => ({
    batchId: i.saleItem.batchId,
    quantity: i.quantity,
  });
  return {
    restocked: restocked.map(ref),
    notRestocked: ret.items.filter((i) => !i.restock).map(ref),
    notRestockedExpired: expired.map(ref),
    saleStatus: fullyReturned ? 'REFUNDED' : sale.status,
  };
}

// ─── Approve / reject ───────────────────────────────────────────────────────

/**
 * Locks the sale, then the return (the same order as createReturn and
 * voidSale, so they can't deadlock), and checks it is still PENDING.
 */
async function lockPendingReturn(tx: Prisma.TransactionClient, id: string) {
  const found = await tx.return.findUnique({ where: { id }, select: { saleId: true } });
  if (!found) throw notFound('Return not found');
  await lockSale(tx, found.saleId);
  await tx.$queryRaw`SELECT "id" FROM "Return" WHERE "id" = ${id}::uuid FOR UPDATE`;

  const ret = await tx.return.findUniqueOrThrow({
    where: { id },
    select: { status: true, returnNumber: true, saleId: true },
  });
  if (ret.status !== 'PENDING') {
    throw conflict(`Return ${ret.returnNumber} is already ${ret.status.toLowerCase()}`);
  }
  return ret;
}

/** Approves a cashier's return: stock and refund happen now. */
export async function approveReturn(id: string, actor: Actor): Promise<ReturnDto> {
  const today = businessToday();
  await prisma.$transaction(async (tx) => {
    const ret = await lockPendingReturn(tx, id);
    await tx.return.update({
      where: { id },
      data: { status: 'COMPLETED', reviewedById: actor.id, reviewedAt: new Date() },
    });
    const effects = await applyReturn(tx, id, actor, today);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'RETURN_APPROVE',
      entityType: 'Return',
      entityId: id,
      before: { status: 'PENDING' },
      after: { status: 'COMPLETED', returnNumber: ret.returnNumber, ...effects },
      meta: actor.meta,
    });
  });
  return loadReturn(id);
}

/** Turns down a cashier's return. Nothing moves, and its units can be returned again. */
export async function rejectReturn(
  id: string,
  input: RejectReturnBody,
  actor: Actor,
): Promise<ReturnDto> {
  await prisma.$transaction(async (tx) => {
    const ret = await lockPendingReturn(tx, id);
    await tx.return.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedById: actor.id,
        reviewedAt: new Date(),
        rejectionReason: input.reason,
      },
    });
    await writeAudit(tx, {
      userId: actor.id,
      action: 'RETURN_REJECT',
      entityType: 'Return',
      entityId: id,
      before: { status: 'PENDING' },
      after: { status: 'REJECTED', returnNumber: ret.returnNumber, reason: input.reason },
      meta: actor.meta,
    });
  });
  return loadReturn(id);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getReturn(id: string, viewer: Viewer): Promise<ReturnDto> {
  const ret = await prisma.return.findUnique({ where: { id }, include: returnInclude });
  // A cashier gets 404, not 403, for someone else's return.
  if (!ret || (!isApprover(viewer.role) && ret.requestedById !== viewer.id)) {
    throw notFound('Return not found');
  }
  return toReturnDto(ret);
}

const summaryInclude = {
  sale: { select: { id: true, receiptNumber: true, soldAt: true } },
  requestedBy: userRef,
  reviewedBy: userRef,
  items: { select: { quantity: true } },
} satisfies Prisma.ReturnInclude;

type SummaryRow = Prisma.ReturnGetPayload<{ include: typeof summaryInclude }>;

function toSummaryDto(r: SummaryRow): ReturnSummaryDto {
  return {
    id: r.id,
    returnNumber: r.returnNumber,
    status: r.status,
    sale: { ...r.sale, soldAt: r.sale.soldAt.toISOString() },
    requestedBy: r.requestedBy,
    requestedAt: r.createdAt.toISOString(),
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    refundTotal: r.refundTotal.toFixed(2),
    itemCount: r.items.reduce((sum, i) => sum + i.quantity, 0),
  };
}

/** Returns newest first. Cashiers only see the ones they requested. */
export async function listReturns(
  query: ListReturnsQuery,
  viewer: Viewer,
): Promise<Paginated<ReturnSummaryDto>> {
  const createdAt: Prisma.DateTimeFilter = {};
  if (query.from) createdAt.gte = startOfBusinessDay(query.from);
  if (query.to) createdAt.lt = startOfBusinessDay(addDays(query.to, 1));

  const where: Prisma.ReturnWhereInput = {
    status: query.status,
    saleId: query.saleId,
    requestedById: isApprover(viewer.role) ? query.requestedById : viewer.id,
    ...(query.q && { returnNumber: { contains: escapeLike(query.q), mode: 'insensitive' } }),
    ...((query.from || query.to) && { createdAt }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.return.count({ where }),
    prisma.return.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return { items: rows.map(toSummaryDto), total, page: query.page, pageSize: query.pageSize };
}

/**
 * A sale as the returns counter sees it: each line with what can still come
 * back, and what each payment method can still refund. Open to every role,
 * since any cashier may take a return for any sale.
 */
export async function getReturnable(query: ReturnableQuery): Promise<ReturnableSaleDto> {
  const sale = await prisma.sale.findUnique({
    where: query.saleId ? { id: query.saleId } : { receiptNumber: query.receiptNumber! },
    include: {
      cashier: userRef,
      items: { include: saleItemInclude, orderBy: { lineNo: 'asc' } },
    },
  });
  if (!sale) throw notFound('Sale not found');

  const reserved = await reservations(prisma, sale.id);
  const lines = sale.items.map((item) => {
    const r = reserved.line(item.id);
    return {
      ...toSaleItemDto(item),
      returnedQuantity: r.completed,
      pendingQuantity: r.pending,
      returnableQuantity: item.quantity - r.completed - r.pending,
    };
  });
  const refundable = PAYMENT_METHODS.flatMap((method) => {
    const paid = reserved.paid.get(method);
    if (paid === undefined) return [];
    return [
      {
        method,
        paid: formatPaisa(paid),
        available: formatPaisa(reserved.capacity.get(method) ?? 0n),
      },
    ];
  });

  return {
    sale: {
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      soldAt: sale.soldAt.toISOString(),
      status: sale.status,
      cashier: sale.cashier,
      grandTotal: sale.grandTotal.toFixed(2),
    },
    lines,
    refundable,
    canReturn: sale.status === 'COMPLETED' && lines.some((l) => l.returnableQuantity > 0),
  };
}
