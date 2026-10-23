import { createHash, randomUUID } from 'node:crypto';
import type {
  CreateSaleBody,
  ListSalesQuery,
  Paginated,
  RoleCode,
  SaleDto,
  SaleItemDto,
  SaleSummaryDto,
  VoidSaleBody,
} from '@pharmacy/shared';
import type { Prisma } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { config } from '../../lib/config';
import { addDays, businessToday, startOfBusinessDay, toDateOnly } from '../../lib/dates';
import {
  AppError,
  badRequest,
  conflict,
  idempotencyKeyReused,
  insufficientStock,
  notFound,
} from '../../lib/errors';
import { formatPaisa, toPaisa } from '../../lib/money';
import { prisma } from '../../lib/prisma';
import { nextDocumentNumber } from '../../lib/receipts';
import { escapeLike } from '../../lib/search';
import { batchQuantities, batchQuantitySql, lockBatches } from '../../lib/stock';
import {
  type PricedLine,
  type SaleLine,
  allocateFefo,
  discountCap,
  priceSale,
  settlePayments,
  splitLine,
} from './sales.calc';

/** The signed-in user making a sale; the role decides the discount cap. */
export type Seller = Actor & { role: RoleCode };
/** Who is reading: cashiers only ever see their own sales (CLAUDE.md rule 9). */
export type Viewer = { id: string; role: RoleCode };
const seesAllSales = (viewer: Viewer) => viewer.role !== 'CASHIER';

// Racing sales wait on each other's batch and receipt-counter locks, and that
// wait counts towards the timeout, so allow more than Prisma's defaults.
const SALE_TX = { maxWait: 10_000, timeout: 20_000 };

// First key of pg_advisory_xact_lock(int, int), so idempotency locks can't
// collide with advisory locks taken for anything else.
const IDEMPOTENCY_LOCK_SPACE = 5_001;

export const userRef = { select: { id: true, username: true, fullName: true } } as const;

/** What a sale line needs for its DTO; shared with returns. */
export const saleItemInclude = {
  batch: {
    select: {
      id: true,
      batchNumber: true,
      expiryDate: true,
      medicine: { select: { id: true, name: true, genericName: true, unit: true } },
    },
  },
} satisfies Prisma.SaleItemInclude;

export type SaleItemRow = Prisma.SaleItemGetPayload<{ include: typeof saleItemInclude }>;

export function toSaleItemDto(i: SaleItemRow): SaleItemDto {
  return {
    id: i.id,
    medicine: i.batch.medicine,
    batch: {
      id: i.batch.id,
      batchNumber: i.batch.batchNumber,
      expiryDate: toDateOnly(i.batch.expiryDate),
    },
    quantity: i.quantity,
    unitPrice: i.unitPrice.toFixed(2),
    discount: i.discount.toFixed(2),
    tax: i.tax.toFixed(2),
    lineTotal: i.lineTotal.toFixed(2),
  };
}

const saleInclude = {
  cashier: userRef,
  voidedBy: userRef,
  items: { include: saleItemInclude, orderBy: { lineNo: 'asc' } },
  // Rows of one sale share a timestamp, so list them in a fixed method order
  // (cash, card, wallet: the enum's order) for a stable receipt.
  payments: { orderBy: [{ method: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.SaleInclude;

type SaleRow = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

function toSaleDto(s: SaleRow): SaleDto {
  return {
    id: s.id,
    receiptNumber: s.receiptNumber,
    idempotencyKey: s.idempotencyKey,
    status: s.status,
    soldAt: s.soldAt.toISOString(),
    cashier: s.cashier,
    subtotal: s.subtotal.toFixed(2),
    discountTotal: s.discountTotal.toFixed(2),
    taxTotal: s.taxTotal.toFixed(2),
    grandTotal: s.grandTotal.toFixed(2),
    changeDue: s.changeDue.toFixed(2),
    amountTendered: formatPaisa(toPaisa(s.grandTotal) + toPaisa(s.changeDue)),
    notes: s.notes,
    items: s.items.map(toSaleItemDto),
    payments: s.payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: p.amount.toFixed(2),
      tendered: p.tendered?.toFixed(2) ?? null,
      reference: p.reference,
    })),
    voidedAt: s.voidedAt?.toISOString() ?? null,
    voidedBy: s.voidedBy,
    voidReason: s.voidReason,
  };
}

async function loadSale(id: string): Promise<SaleDto> {
  return toSaleDto(await prisma.sale.findUniqueOrThrow({ where: { id }, include: saleInclude }));
}

// ─── Create ─────────────────────────────────────────────────────────────────

export type CreateSaleResult = { sale: SaleDto; replayed: boolean };

/**
 * Records a completed sale in one transaction (CLAUDE.md rule 4): prices the
 * cart from the catalogue, takes stock from unexpired batches earliest expiry
 * first, settles the payments, numbers the receipt, and writes the sale,
 * its lines, SALE movements, payments and audit entry together.
 *
 * Sending the same idempotency key again returns the sale saved the first
 * time (`replayed: true`) instead of selling twice.
 */
export async function createSale(input: CreateSaleBody, seller: Seller): Promise<CreateSaleResult> {
  const today = businessToday();
  const requestHash = hashRequest(input);

  const { saleId, replayed } = await prisma.$transaction(async (tx) => {
    // Requests with the same key queue here, so a retry that arrives while the
    // first attempt is still running waits for it and then finds its sale.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(${IDEMPOTENCY_LOCK_SPACE}::int, hashtext(${input.idempotencyKey}))`;
    const existing = await tx.sale.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, cashierId: true, requestHash: true },
    });
    if (existing) {
      if (existing.cashierId !== seller.id || existing.requestHash !== requestHash) {
        throw idempotencyKeyReused('This idempotency key was already used for a different sale');
      }
      return { saleId: existing.id, replayed: true };
    }

    const medicines = await loadSellableMedicines(tx, input);
    const priced = priceSale(
      input.items.map((item) => ({
        quantity: item.quantity,
        unitPrice: toPaisa(medicines.get(item.medicineId)!.sellingPrice),
        discount: item.discount,
      })),
      input.discount,
    );
    if (seller.role === 'CASHIER') {
      const maxPercent = config.CASHIER_MAX_DISCOUNT_PERCENT;
      const cap = discountCap(priced.subtotal, maxPercent);
      if (priced.discountTotal > cap) {
        throw new AppError(
          403,
          'FORBIDDEN',
          `Cashiers can give at most ${maxPercent}% discount (${formatPaisa(cap)} on this bill); ask a pharmacist`,
          {
            maxPercent,
            maxDiscount: formatPaisa(cap),
            requested: formatPaisa(priced.discountTotal),
          },
        );
      }
    }
    const settlement = settlePayments(
      priced.grandTotal,
      input.payments.map((p) => ({
        method: p.method,
        amount: toPaisa(p.amount),
        reference: p.reference ?? null,
      })),
    );

    // Everything above is cheap validation; stock locks are taken only now,
    // and held until commit.
    const lines = await allocateStock(tx, input, priced.lines, medicines, today);
    const receiptNumber = await nextDocumentNumber(tx, 'S', today);

    const sale = await tx.sale.create({
      data: {
        receiptNumber,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        cashierId: seller.id,
        subtotal: formatPaisa(priced.subtotal),
        discountTotal: formatPaisa(priced.discountTotal),
        grandTotal: formatPaisa(priced.grandTotal),
        changeDue: formatPaisa(settlement.change),
        notes: input.notes ?? null,
      },
      select: { id: true },
    });
    const items = lines.map((line, i) => ({
      id: randomUUID(),
      saleId: sale.id,
      lineNo: i + 1,
      batchId: line.batchId,
      quantity: line.quantity,
      unitPrice: formatPaisa(line.unitPrice),
      discount: formatPaisa(line.discount),
      lineTotal: formatPaisa(line.lineTotal),
    }));
    await tx.saleItem.createMany({ data: items });
    // The balance trigger re-checks each batch here, as a last line of defence.
    await tx.stockMovement.createMany({
      data: items.map((item) => ({
        batchId: item.batchId,
        type: 'SALE' as const,
        quantity: -item.quantity,
        reason: `Sale ${receiptNumber}`,
        userId: seller.id,
        saleItemId: item.id,
      })),
    });
    if (settlement.payments.length > 0) {
      await tx.payment.createMany({
        data: settlement.payments.map((p) => ({
          saleId: sale.id,
          method: p.method,
          amount: formatPaisa(p.amount),
          tendered: p.tendered === null ? null : formatPaisa(p.tendered),
          reference: p.reference,
        })),
      });
    }

    await writeAudit(tx, {
      userId: seller.id,
      action: 'SALE_CREATE',
      entityType: 'Sale',
      entityId: sale.id,
      after: {
        receiptNumber,
        idempotencyKey: input.idempotencyKey,
        subtotal: formatPaisa(priced.subtotal),
        discountTotal: formatPaisa(priced.discountTotal),
        grandTotal: formatPaisa(priced.grandTotal),
        changeDue: formatPaisa(settlement.change),
        discount: input.discount ?? null,
        items: items.map((item, i) => ({
          medicineId: lines[i]!.medicineId,
          batchId: item.batchId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          lineTotal: item.lineTotal,
        })),
        payments: settlement.payments.map((p) => ({
          method: p.method,
          amount: formatPaisa(p.amount),
          tendered: p.tendered === null ? null : formatPaisa(p.tendered),
        })),
      },
      meta: seller.meta,
    });
    return { saleId: sale.id, replayed: false };
  }, SALE_TX);

  return { sale: await loadSale(saleId), replayed };
}

/** SHA-256 of everything in the request except the key itself. */
function hashRequest(input: CreateSaleBody): string {
  const { idempotencyKey: _key, ...rest } = input;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

type MedicineRow = { id: string; name: string; unit: string; sellingPrice: Prisma.Decimal };

async function loadSellableMedicines(
  tx: Prisma.TransactionClient,
  input: CreateSaleBody,
): Promise<Map<string, MedicineRow>> {
  const rows = await tx.medicine.findMany({
    where: { id: { in: input.items.map((i) => i.medicineId) } },
    select: { id: true, name: true, unit: true, sellingPrice: true, status: true },
  });
  const byId = new Map(rows.map((m) => [m.id, m]));
  const issues = input.items.flatMap((item, index) => {
    const medicine = byId.get(item.medicineId);
    if (!medicine) return [{ index, field: 'medicineId', message: 'Medicine does not exist' }];
    if (medicine.status !== 'ACTIVE') {
      return [{ index, field: 'medicineId', message: `"${medicine.name}" is inactive` }];
    }
    return [];
  });
  if (issues.length > 0) throw badRequest('Some items cannot be sold', { items: issues });
  return byId;
}

type AllocatedLine = SaleLine & { medicineId: string };

/**
 * FEFO (CLAUDE.md rules 1-3): for each cart line, takes stock from unexpired
 * batches earliest expiry first, one sale line per batch used. Candidate
 * batches are locked before their balances are read, so two sales can't
 * spend the same units; a racing sale waits here until this one commits and
 * then sees what is left. If any line is short, nothing is sold.
 */
async function allocateStock(
  tx: Prisma.TransactionClient,
  input: CreateSaleBody,
  pricedLines: PricedLine[],
  medicines: Map<string, MedicineRow>,
  today: string,
): Promise<AllocatedLine[]> {
  const medicineIds = input.items.map((i) => i.medicineId);
  const candidates = await tx.$queryRaw<{ id: string }[]>`
    SELECT b."id" FROM "Batch" b
    WHERE b."medicineId" = ANY(${medicineIds}::uuid[])
      AND b."expiryDate" > ${today}::date
      AND ${batchQuantitySql} > 0`;
  const ids = candidates.map((c) => c.id);
  await lockBatches(tx, ids);

  // Read after locking, so the quantities are final for this transaction.
  const quantities = await batchQuantities(tx, ids);
  const batches = await tx.batch.findMany({
    where: { id: { in: ids } },
    select: { id: true, medicineId: true },
    orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });

  const lines: AllocatedLine[] = [];
  const shortages: { index: number; medicineId: string; requested: number; available: number }[] =
    [];
  input.items.forEach((item, index) => {
    const sellable = batches
      .filter((b) => b.medicineId === item.medicineId)
      .map((b) => ({ id: b.id, quantity: quantities.get(b.id)! }));
    const allocations = allocateFefo(sellable, item.quantity);
    if (!allocations) {
      const available = sellable.reduce((sum, b) => sum + b.quantity, 0);
      shortages.push({ index, medicineId: item.medicineId, requested: item.quantity, available });
      return;
    }
    for (const line of splitLine(pricedLines[index]!, allocations)) {
      lines.push({ ...line, medicineId: item.medicineId });
    }
  });

  if (shortages.length > 0) {
    throw await shortageError(tx, shortages, medicines, today);
  }
  return lines;
}

/**
 * INSUFFICIENT_STOCK listing each short line, with how much is sitting in
 * expired batches so the counter can tell "out of stock" from "expired".
 */
async function shortageError(
  tx: Prisma.TransactionClient,
  shortages: { index: number; medicineId: string; requested: number; available: number }[],
  medicines: Map<string, MedicineRow>,
  today: string,
) {
  const expiredRows = await tx.$queryRaw<{ medicineId: string; qty: number }[]>`
    SELECT x."medicineId", SUM(x."qty")::int AS "qty" FROM (
      SELECT b."medicineId", ${batchQuantitySql} AS "qty" FROM "Batch" b
      WHERE b."medicineId" = ANY(${shortages.map((s) => s.medicineId)}::uuid[])
        AND b."expiryDate" <= ${today}::date
    ) x
    GROUP BY x."medicineId"`;
  const expired = new Map(expiredRows.map((r) => [r.medicineId, r.qty]));

  const items = shortages.map((s) => {
    const medicine = medicines.get(s.medicineId)!;
    return {
      ...s,
      name: medicine.name,
      unit: medicine.unit,
      expiredQuantity: expired.get(s.medicineId) ?? 0,
    };
  });
  const [first] = items;
  const message =
    items.length === 1 && first
      ? `Not enough stock of ${first.name}: ${first.requested} ${first.unit} requested, ${first.available} available`
      : 'Not enough stock for some items';
  return insufficientStock(message, { items });
}

// ─── Void ───────────────────────────────────────────────────────────────────

/**
 * Cancels a completed sale: every line's units go back to the batch they
 * came from as RETURN movements, and the sale is kept with status VOIDED
 * (CLAUDE.md rule 7). Once anything has been returned against the sale, or
 * a return is waiting for approval, it must be handled through returns.
 */
export async function voidSale(id: string, input: VoidSaleBody, actor: Actor): Promise<SaleDto> {
  await prisma.$transaction(async (tx) => {
    // Lock the sale so two voids (or a void and a return) can't both proceed.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Sale" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound('Sale not found');

    const sale = await tx.sale.findUniqueOrThrow({
      where: { id },
      include: {
        items: { orderBy: { lineNo: 'asc' } },
        _count: { select: { returns: { where: { status: { in: ['PENDING', 'COMPLETED'] } } } } },
      },
    });
    if (sale.status === 'VOIDED') throw conflict(`Sale ${sale.receiptNumber} is already voided`);
    if (sale.status !== 'COMPLETED') {
      throw conflict(
        `Sale ${sale.receiptNumber} is ${sale.status.toLowerCase()} and cannot be voided`,
      );
    }
    if (sale._count.returns > 0) {
      throw conflict(
        `Items from sale ${sale.receiptNumber} have been returned or are awaiting return approval; use returns instead of voiding`,
      );
    }

    const reason = `Void of sale ${sale.receiptNumber}: ${input.reason}`;
    await tx.stockMovement.createMany({
      data: sale.items.map((item) => ({
        batchId: item.batchId,
        type: 'RETURN' as const,
        quantity: item.quantity,
        reason,
        userId: actor.id,
        saleItemId: item.id,
      })),
    });
    const voided = await tx.sale.update({
      where: { id },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidedById: actor.id,
        voidReason: input.reason,
      },
      select: { voidedAt: true },
    });

    await writeAudit(tx, {
      userId: actor.id,
      action: 'SALE_VOID',
      entityType: 'Sale',
      entityId: id,
      before: { status: sale.status },
      after: {
        status: 'VOIDED',
        receiptNumber: sale.receiptNumber,
        reason: input.reason,
        voidedAt: voided.voidedAt,
        restocked: sale.items.map((i) => ({ batchId: i.batchId, quantity: i.quantity })),
      },
      meta: actor.meta,
    });
  });
  return loadSale(id);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getSale(id: string, viewer: Viewer): Promise<SaleDto> {
  const sale = await prisma.sale.findUnique({ where: { id }, include: saleInclude });
  // A cashier gets 404, not 403, for someone else's sale: no hint that it exists.
  if (!sale || (!seesAllSales(viewer) && sale.cashierId !== viewer.id)) {
    throw notFound('Sale not found');
  }
  return toSaleDto(sale);
}

const summaryInclude = {
  cashier: userRef,
  items: { select: { quantity: true } },
  payments: { select: { method: true }, orderBy: { method: 'asc' } },
} satisfies Prisma.SaleInclude;

type SummaryRow = Prisma.SaleGetPayload<{ include: typeof summaryInclude }>;

function toSummaryDto(s: SummaryRow): SaleSummaryDto {
  return {
    id: s.id,
    receiptNumber: s.receiptNumber,
    status: s.status,
    soldAt: s.soldAt.toISOString(),
    cashier: s.cashier,
    subtotal: s.subtotal.toFixed(2),
    discountTotal: s.discountTotal.toFixed(2),
    taxTotal: s.taxTotal.toFixed(2),
    grandTotal: s.grandTotal.toFixed(2),
    changeDue: s.changeDue.toFixed(2),
    itemCount: s.items.reduce((sum, i) => sum + i.quantity, 0),
    paymentMethods: [...new Set(s.payments.map((p) => p.method))],
  };
}

/** Sales newest first. Cashiers only see their own. */
export async function listSales(
  query: ListSalesQuery,
  viewer: Viewer,
): Promise<Paginated<SaleSummaryDto>> {
  const soldAt: Prisma.DateTimeFilter = {};
  if (query.from) soldAt.gte = startOfBusinessDay(query.from);
  if (query.to) soldAt.lt = startOfBusinessDay(addDays(query.to, 1));

  const where: Prisma.SaleWhereInput = {
    status: query.status,
    cashierId: seesAllSales(viewer) ? query.cashierId : viewer.id,
    ...(query.q && { receiptNumber: { contains: escapeLike(query.q), mode: 'insensitive' } }),
    ...((query.from || query.to) && { soldAt }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ soldAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return { items: rows.map(toSummaryDto), total, page: query.page, pageSize: query.pageSize };
}
