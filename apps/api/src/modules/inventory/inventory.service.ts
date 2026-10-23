import type {
  AdjustStockBody,
  BatchStockDto,
  ExpiredStockQuery,
  ExpiredWriteOffDto,
  ExpiringStockDto,
  ExpiringStockQuery,
  ListMovementsQuery,
  ListStockQuery,
  LowStockQuery,
  MedicineStockDto,
  MedicineStockQuery,
  OfflineCatalogueDto,
  OfflineMedicineDto,
  Paginated,
  ReceiveStockBody,
  RoleCode,
  SellableMedicineDto,
  SellableSearchQuery,
  StockAdjustmentDto,
  StockMovementDto,
  StockSummaryDto,
  SubstitutesDto,
  WriteOffExpiredBody,
} from '@pharmacy/shared';
import { Prisma, type RecordStatus } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { config } from '../../lib/config';
import {
  addDays,
  addYears,
  businessToday,
  daysBetween,
  fromDateOnly,
  isExpiredOn,
  toDateOnly,
} from '../../lib/dates';
import { badRequest, conflict, insufficientStock, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';
import { batchQuantities, batchQuantitySql, lockBatches } from '../../lib/stock';

/** Who is reading: decides whether purchase prices are shown. */
export type Viewer = { role: RoleCode };
const canSeeCost = (viewer: Viewer) => viewer.role !== 'CASHIER';
// Write endpoints are manager-only, and the audit log is admin-only.
const FULL_VIEW: Viewer = { role: 'ADMIN' };

/** An expiry further out than this is almost certainly a typo (e.g. 2207 for 2027). */
const MAX_SHELF_LIFE_YEARS = 10;

// Receipts and bulk write-offs write a few rows per line, so allow more than
// Prisma's 5s default.
const BULK_TX = { timeout: 30_000 };

const batchInclude = {
  medicine: { select: { id: true, name: true, genericName: true, unit: true } },
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.BatchInclude;

type BatchRow = Prisma.BatchGetPayload<{ include: typeof batchInclude }>;

function toBatchStockDto(
  b: BatchRow,
  quantity: number,
  today: string,
  viewer: Viewer,
): BatchStockDto {
  const expiryDate = toDateOnly(b.expiryDate);
  return {
    id: b.id,
    medicine: { ...b.medicine },
    supplier: { ...b.supplier },
    batchNumber: b.batchNumber,
    expiryDate,
    isExpired: isExpiredOn(expiryDate, today),
    daysToExpiry: daysBetween(today, expiryDate),
    quantity,
    quantityReceived: b.quantityReceived,
    costPrice: canSeeCost(viewer) ? b.costPrice.toFixed(2) : null,
    receivedAt: b.createdAt.toISOString(),
  };
}

const movementInclude = {
  batch: {
    select: { id: true, batchNumber: true, medicine: { select: { id: true, name: true } } },
  },
  user: { select: { id: true, username: true, fullName: true } },
} satisfies Prisma.StockMovementInclude;

type MovementRow = Prisma.StockMovementGetPayload<{ include: typeof movementInclude }>;

function toMovementDto(m: MovementRow): StockMovementDto {
  return {
    id: m.id,
    type: m.type,
    quantity: m.quantity,
    reason: m.reason,
    batch: m.batch,
    user: m.user,
    saleItemId: m.saleItemId,
    returnItemId: m.returnItemId,
    createdAt: m.createdAt.toISOString(),
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────

type ItemIssue = { index: number; field: string; message: string };

/**
 * Receives one supplier delivery. Every line becomes a new Batch plus a
 * PURCHASE movement for its quantity, all in one transaction: if any line is
 * invalid, nothing is received.
 */
export async function receiveStock(
  input: ReceiveStockBody,
  actor: Actor,
): Promise<BatchStockDto[]> {
  const today = businessToday();
  const latestExpiry = addYears(today, MAX_SHELF_LIFE_YEARS);
  const dateIssues = input.items.flatMap((item, index): ItemIssue[] => {
    if (isExpiredOn(item.expiryDate, today)) {
      const message = `Expiry date ${item.expiryDate} is not after today (${today}); expired stock cannot be received`;
      return [{ index, field: 'expiryDate', message }];
    }
    if (item.expiryDate > latestExpiry) {
      const message = `Expiry date ${item.expiryDate} is more than ${MAX_SHELF_LIFE_YEARS} years away; check for a typo`;
      return [{ index, field: 'expiryDate', message }];
    }
    return [];
  });
  if (dateIssues.length > 0) {
    throw badRequest('Some items cannot be received', { items: dateIssues });
  }

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({
      where: { id: input.supplierId },
      select: { status: true },
    });
    if (!supplier) throw badRequest('Supplier does not exist', { field: 'supplierId' });
    if (supplier.status !== 'ACTIVE') {
      throw badRequest('Supplier is inactive', { field: 'supplierId' });
    }

    const medicines = await tx.medicine.findMany({
      where: { id: { in: [...new Set(input.items.map((i) => i.medicineId))] } },
      select: { id: true, name: true, status: true },
    });
    const medicineById = new Map(medicines.map((m) => [m.id, m]));
    const medicineIssues = input.items.flatMap((item, index): ItemIssue[] => {
      const medicine = medicineById.get(item.medicineId);
      if (!medicine) return [{ index, field: 'medicineId', message: 'Medicine does not exist' }];
      if (medicine.status !== 'ACTIVE') {
        return [{ index, field: 'medicineId', message: `"${medicine.name}" is inactive` }];
      }
      return [];
    });
    if (medicineIssues.length > 0) {
      throw badRequest('Some items cannot be received', { items: medicineIssues });
    }

    // A lot can arrive more than once (a top-up from the same production run),
    // and each delivery gets its own Batch row. But one manufacturer lot has
    // one expiry date, so a different date means a data-entry mistake.
    const earlier = await tx.batch.findMany({
      where: {
        OR: input.items.map((i) => ({ medicineId: i.medicineId, batchNumber: i.batchNumber })),
      },
      select: { medicineId: true, batchNumber: true, expiryDate: true },
    });
    const lotIssues = input.items.flatMap((item, index): ItemIssue[] => {
      const clash = earlier.find(
        (b) =>
          b.medicineId === item.medicineId &&
          b.batchNumber === item.batchNumber &&
          toDateOnly(b.expiryDate) !== item.expiryDate,
      );
      if (!clash) return [];
      const message = `Batch ${item.batchNumber} of this medicine was received before with expiry ${toDateOnly(clash.expiryDate)}`;
      return [{ index, field: 'expiryDate', message }];
    });
    if (lotIssues.length > 0) {
      throw conflict('Expiry dates clash with earlier receipts of the same batch', {
        items: lotIssues,
      });
    }

    const reason = input.invoiceNumber ? `Invoice ${input.invoiceNumber}` : null;
    const received: BatchStockDto[] = [];
    for (const item of input.items) {
      const batch = await tx.batch.create({
        data: {
          medicineId: item.medicineId,
          supplierId: input.supplierId,
          batchNumber: item.batchNumber,
          expiryDate: fromDateOnly(item.expiryDate),
          costPrice: new Prisma.Decimal(item.costPrice),
          quantityReceived: item.quantity,
        },
        include: batchInclude,
      });
      const movement = await tx.stockMovement.create({
        data: {
          batchId: batch.id,
          type: 'PURCHASE',
          quantity: item.quantity,
          reason,
          userId: actor.id,
        },
      });
      const dto = toBatchStockDto(batch, item.quantity, today, FULL_VIEW);
      await writeAudit(tx, {
        userId: actor.id,
        action: 'STOCK_RECEIVE',
        entityType: 'Batch',
        entityId: batch.id,
        after: { ...dto, invoiceNumber: input.invoiceNumber ?? null, movementId: movement.id },
        meta: actor.meta,
      });
      received.push(dto);
    }
    return received;
  }, BULK_TX);
}

/**
 * Corrects one batch's count. Removing more than the batch holds is rejected:
 * stock never goes negative (rule 3).
 */
export async function adjustStock(
  input: AdjustStockBody,
  actor: Actor,
): Promise<StockAdjustmentDto> {
  const today = businessToday();
  return prisma.$transaction(async (tx) => {
    const found = await lockBatches(tx, [input.batchId]);
    if (!found.has(input.batchId)) throw notFound('Batch not found');

    const batch = await tx.batch.findUniqueOrThrow({
      where: { id: input.batchId },
      include: batchInclude,
    });
    const before = (await batchQuantities(tx, [batch.id])).get(batch.id)!;
    const after = before + input.quantity;
    if (after < 0) {
      throw insufficientStock(
        `Cannot remove ${-input.quantity} ${batch.medicine.unit}: batch ${batch.batchNumber} has only ${before} in stock`,
        { batchId: batch.id, available: before, requested: -input.quantity },
      );
    }

    const movement = await tx.stockMovement.create({
      data: {
        batchId: batch.id,
        type: 'ADJUSTMENT',
        quantity: input.quantity,
        reason: input.reason,
        userId: actor.id,
      },
      include: movementInclude,
    });
    await writeAudit(tx, {
      userId: actor.id,
      action: 'STOCK_ADJUST',
      entityType: 'Batch',
      entityId: batch.id,
      before: { quantity: before },
      after: {
        quantity: after,
        change: input.quantity,
        reason: input.reason,
        movementId: movement.id,
      },
      meta: actor.meta,
    });

    return {
      movement: toMovementDto(movement),
      quantityBefore: before,
      quantityAfter: after,
      batch: toBatchStockDto(batch, after, today, FULL_VIEW),
    };
  });
}

/**
 * Removes the full remaining stock of expired batches with EXPIRED_WRITEOFF
 * movements. Named batches must all be expired and have stock, or nothing is
 * written off; with no ids, every expired batch that has stock is cleared.
 */
export async function writeOffExpired(
  input: WriteOffExpiredBody,
  actor: Actor,
): Promise<ExpiredWriteOffDto> {
  const today = businessToday();
  return prisma.$transaction(async (tx) => {
    let ids: string[];
    if (input.batchIds) {
      ids = input.batchIds;
      const found = await lockBatches(tx, ids);
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw badRequest('Some batches do not exist', { batchIds: missing });
      }
    } else {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT b."id" FROM "Batch" b
        WHERE b."expiryDate" <= ${today}::date AND ${batchQuantitySql} > 0`;
      ids = candidates.map((c) => c.id);
      await lockBatches(tx, ids);
    }

    // Read after locking, so the quantities are final for this transaction.
    const quantities = await batchQuantities(tx, ids);
    const batches = await tx.batch.findMany({
      where: { id: { in: ids } },
      include: batchInclude,
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
    });

    if (input.batchIds) {
      const problems = batches.flatMap((b) => {
        const expiry = toDateOnly(b.expiryDate);
        if (!isExpiredOn(expiry, today)) {
          const message = `Batch ${b.batchNumber} expires on ${expiry} and is not expired yet`;
          return [{ batchId: b.id, message }];
        }
        if (quantities.get(b.id)! <= 0) {
          return [{ batchId: b.id, message: `Batch ${b.batchNumber} has no stock to write off` }];
        }
        return [];
      });
      if (problems.length > 0) {
        throw badRequest('Some batches cannot be written off', { batches: problems });
      }
    }

    const reason = input.reason ?? 'Expired stock write-off';
    const items: ExpiredWriteOffDto['items'] = [];
    for (const batch of batches) {
      const quantity = quantities.get(batch.id)!;
      // Emptied by a concurrent sale/adjustment after the candidate scan.
      if (quantity <= 0) continue;

      const movement = await tx.stockMovement.create({
        data: {
          batchId: batch.id,
          type: 'EXPIRED_WRITEOFF',
          quantity: -quantity,
          reason,
          userId: actor.id,
        },
        include: movementInclude,
      });
      await writeAudit(tx, {
        userId: actor.id,
        action: 'STOCK_EXPIRED_WRITEOFF',
        entityType: 'Batch',
        entityId: batch.id,
        before: { quantity },
        after: { quantity: 0, reason, movementId: movement.id },
        meta: actor.meta,
      });
      items.push({
        movement: toMovementDto(movement),
        batch: toBatchStockDto(batch, 0, today, FULL_VIEW),
        quantity,
      });
    }

    return { items, totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0) };
  }, BULK_TX);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Stock for one medicine with its batches, earliest expiry first. */
export async function getMedicineStock(
  medicineId: string,
  query: MedicineStockQuery,
  viewer: Viewer,
): Promise<MedicineStockDto> {
  const today = businessToday();
  const [medicine, batches] = await prisma.$transaction([
    prisma.medicine.findUnique({
      where: { id: medicineId },
      select: {
        id: true,
        name: true,
        genericName: true,
        barcode: true,
        unit: true,
        reorderLevel: true,
        status: true,
      },
    }),
    prisma.batch.findMany({
      where: { medicineId },
      include: batchInclude,
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  if (!medicine) throw notFound('Medicine not found');

  const quantities = await batchQuantities(
    prisma,
    batches.map((b) => b.id),
  );
  const all = batches.map((b) => toBatchStockDto(b, quantities.get(b.id)!, today, viewer));

  let sellableQuantity = 0;
  let expiredQuantity = 0;
  for (const b of all) {
    if (b.isExpired) expiredQuantity += b.quantity;
    else sellableQuantity += b.quantity;
  }

  return {
    medicine,
    sellableQuantity,
    expiredQuantity,
    totalQuantity: sellableQuantity + expiredQuantity,
    isLowStock: sellableQuantity <= medicine.reorderLevel,
    nextExpiry: all.find((b) => !b.isExpired && b.quantity > 0)?.expiryDate ?? null,
    batches: query.includeEmpty ? all : all.filter((b) => b.quantity !== 0),
  };
}

export async function getBatch(id: string, viewer: Viewer): Promise<BatchStockDto> {
  const batch = await prisma.batch.findUnique({ where: { id }, include: batchInclude });
  if (!batch) throw notFound('Batch not found');
  const quantity = (await batchQuantities(prisma, [id])).get(id)!;
  return toBatchStockDto(batch, quantity, businessToday(), viewer);
}

type StockRow = {
  id: string;
  name: string;
  genericName: string | null;
  barcode: string | null;
  unit: string;
  reorderLevel: number;
  status: RecordStatus;
  sellable: number;
  expired: number;
  nextExpiry: Date | null;
};

/**
 * Per-medicine stock totals as SQL, aliased `m` (Medicine) and `s` (totals).
 * The lateral aggregate runs per medicine row, so with ORDER BY/LIMIT on `m`
 * only the requested page is summed.
 */
function stockSql(today: string, where: Prisma.Sql) {
  return Prisma.sql`
    FROM "Medicine" m
    CROSS JOIN LATERAL (${stockTotalsSql(today)}) s
    ${where}`;
}

/** The per-medicine totals subquery, for a lateral join on a Medicine row aliased `m`. */
function stockTotalsSql(today: string) {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(bs."qty") FILTER (WHERE bs."expiryDate" > ${today}::date), 0)::int AS "sellable",
      COALESCE(SUM(bs."qty") FILTER (WHERE bs."expiryDate" <= ${today}::date), 0)::int AS "expired",
      MIN(bs."expiryDate") FILTER (WHERE bs."expiryDate" > ${today}::date AND bs."qty" > 0) AS "nextExpiry"
    FROM (
      SELECT b."expiryDate", ${batchQuantitySql} AS "qty"
      FROM "Batch" b WHERE b."medicineId" = m."id"
    ) bs`;
}

const stockColumns = Prisma.sql`
  m."id", m."name", m."genericName", m."barcode", m."unit", m."reorderLevel", m."status",
  s."sellable", s."expired", s."nextExpiry"`;

function toStockSummaryDto(r: StockRow): StockSummaryDto {
  return {
    medicine: {
      id: r.id,
      name: r.name,
      genericName: r.genericName,
      barcode: r.barcode,
      unit: r.unit,
      reorderLevel: r.reorderLevel,
      status: r.status,
    },
    sellableQuantity: r.sellable,
    expiredQuantity: r.expired,
    totalQuantity: r.sellable + r.expired,
    isLowStock: r.sellable <= r.reorderLevel,
    nextExpiry: r.nextExpiry ? toDateOnly(r.nextExpiry) : null,
  };
}

const whereSql = (conditions: Prisma.Sql[]) =>
  conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

const pageSql = (q: { page: number; pageSize: number }) =>
  Prisma.sql`LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

/** Stock totals for every medicine matching the filters, alphabetically. */
export async function listStock(query: ListStockQuery): Promise<Paginated<StockSummaryDto>> {
  const today = businessToday();
  const conditions: Prisma.Sql[] = [];
  if (query.status) conditions.push(Prisma.sql`m."status" = ${query.status}::"RecordStatus"`);
  if (query.categoryId) conditions.push(Prisma.sql`m."categoryId" = ${query.categoryId}::uuid`);
  if (query.q) {
    const contains = `%${escapeLike(query.q)}%`;
    conditions.push(Prisma.sql`(m."name" ILIKE ${contains} OR m."genericName" ILIKE ${contains})`);
  }
  const where = whereSql(conditions);

  const [[{ total }], rows] = await prisma.$transaction([
    prisma.$queryRaw<[{ total: number }]>`SELECT count(*)::int AS total FROM "Medicine" m ${where}`,
    prisma.$queryRaw<StockRow[]>`
      SELECT ${stockColumns} ${stockSql(today, where)}
      ORDER BY m."name", m."id" ${pageSql(query)}`,
  ]);
  return { items: rows.map(toStockSummaryDto), total, page: query.page, pageSize: query.pageSize };
}

// ─── Billing lookups ────────────────────────────────────────────────────────

type SellableRow = {
  id: string;
  name: string;
  genericName: string | null;
  barcode: string | null;
  unit: string;
  sellingPrice: Prisma.Decimal;
  reorderLevel: number;
  sellable: number;
  expired: number;
  nextExpiry: Date | null;
  barcodeMatch: boolean;
};

const sellableColumns = Prisma.sql`
  m."id", m."name", m."genericName", m."barcode", m."unit", m."sellingPrice", m."reorderLevel",
  s."sellable", s."expired", s."nextExpiry"`;

function toSellableDto(r: SellableRow): SellableMedicineDto {
  return {
    id: r.id,
    name: r.name,
    genericName: r.genericName,
    barcode: r.barcode,
    unit: r.unit,
    sellingPrice: r.sellingPrice.toFixed(2),
    sellableQuantity: r.sellable,
    expiredQuantity: r.expired,
    isLowStock: r.sellable <= r.reorderLevel,
    nextExpiry: r.nextExpiry ? toDateOnly(r.nextExpiry) : null,
    barcodeMatch: r.barcodeMatch,
  };
}

/**
 * The billing screen's search: active medicines whose barcode equals the
 * term (a scan) or whose brand or generic name contains it. Ranked exact
 * barcode, exact name, name prefix, generic prefix, then the rest. Out-of-
 * stock medicines are included so the counter can offer a substitute.
 *
 * The inner query picks and limits the page first, so stock is only summed
 * for the rows returned.
 */
export async function searchSellable(query: SellableSearchQuery): Promise<SellableMedicineDto[]> {
  const today = businessToday();
  const term = escapeLike(query.q);
  const contains = `%${term}%`;
  const prefix = `${term}%`;
  const rows = await prisma.$queryRaw<SellableRow[]>`
    SELECT ${sellableColumns}, m."rank" = 0 AS "barcodeMatch"
    FROM (
      SELECT m.*, CASE
        WHEN m."barcode" = ${query.q} THEN 0
        WHEN m."name" ILIKE ${term} THEN 1
        WHEN m."name" ILIKE ${prefix} THEN 2
        WHEN m."genericName" ILIKE ${prefix} THEN 3
        ELSE 4 END AS "rank"
      FROM "Medicine" m
      WHERE m."status" = 'ACTIVE'
        AND (m."barcode" = ${query.q} OR m."name" ILIKE ${contains} OR m."genericName" ILIKE ${contains})
      ORDER BY "rank", m."name", m."id"
      LIMIT ${query.limit}
    ) m
    CROSS JOIN LATERAL (${stockTotalsSql(today)}) s
    ORDER BY m."rank", m."name", m."id"`;
  return rows.map(toSellableDto);
}

async function sellableRow(medicineId: string, today: string): Promise<SellableRow> {
  const [row] = await prisma.$queryRaw<SellableRow[]>`
    SELECT ${sellableColumns}, false AS "barcodeMatch"
    FROM "Medicine" m CROSS JOIN LATERAL (${stockTotalsSql(today)}) s
    WHERE m."id" = ${medicineId}::uuid`;
  if (!row) throw notFound('Medicine not found');
  return row;
}

/**
 * Current price and stock of one medicine, e.g. to refresh a held bill
 * before it is paid. Inactive medicines are found too; the sale rejects them.
 */
export async function getSellable(medicineId: string): Promise<SellableMedicineDto> {
  return toSellableDto(await sellableRow(medicineId, businessToday()));
}

/**
 * Every active medicine with its price and each batch that has stock, so the
 * billing screen can keep selling while the server is unreachable. Expired
 * batches are included (the device works out what has expired by the time
 * it sells); batches come in the order sales take them (FEFO). No cost prices.
 */
export async function getOfflineCatalogue(now = new Date()): Promise<OfflineCatalogueDto> {
  const [medicines, batches] = await prisma.$transaction([
    prisma.medicine.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        genericName: true,
        barcode: true,
        unit: true,
        sellingPrice: true,
        reorderLevel: true,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.$queryRaw<
      { id: string; medicineId: string; batchNumber: string; expiryDate: Date; qty: number }[]
    >`
      SELECT b."id", b."medicineId", b."batchNumber", b."expiryDate", s."qty"
      FROM (
        SELECT "batchId", SUM("quantity")::int AS "qty" FROM "StockMovement" GROUP BY "batchId"
      ) s
      JOIN "Batch" b ON b."id" = s."batchId"
      JOIN "Medicine" m ON m."id" = b."medicineId"
      WHERE m."status" = 'ACTIVE' AND s."qty" > 0
      ORDER BY b."expiryDate", b."createdAt", b."id"`,
  ]);

  const byMedicine = new Map<string, OfflineMedicineDto>(
    medicines.map((m) => [m.id, { ...m, sellingPrice: m.sellingPrice.toFixed(2), batches: [] }]),
  );
  for (const b of batches) {
    byMedicine.get(b.medicineId)?.batches.push({
      id: b.id,
      batchNumber: b.batchNumber,
      expiryDate: toDateOnly(b.expiryDate),
      quantity: b.qty,
    });
  }
  return {
    generatedAt: now.toISOString(),
    businessDate: businessToday(now),
    timeZone: config.BUSINESS_TIMEZONE,
    cashierMaxDiscountPercent: config.CASHIER_MAX_DISCOUNT_PERCENT,
    offlineSaleMaxAgeDays: config.OFFLINE_SALE_MAX_AGE_DAYS,
    medicines: [...byMedicine.values()],
  };
}

/** Most substitutes listed for one medicine. */
const MAX_SUBSTITUTES = 20;

/**
 * Active medicines with the same generic/salt name (case-insensitive) that
 * have sellable stock, for when the one asked for is out of stock. Largest
 * stock first, so the counter reaches for what is plentiful.
 */
export async function listSubstitutes(medicineId: string): Promise<SubstitutesDto> {
  const today = businessToday();
  const row = await sellableRow(medicineId, today);
  if (!row.genericName) return { medicine: toSellableDto(row), substitutes: [] };

  // ILIKE without wildcards is an exact, case-insensitive match served by the
  // trigram index on genericName.
  const rows = await prisma.$queryRaw<SellableRow[]>`
    SELECT ${sellableColumns}, false AS "barcodeMatch"
    FROM "Medicine" m CROSS JOIN LATERAL (${stockTotalsSql(today)}) s
    WHERE m."status" = 'ACTIVE'
      AND m."id" <> ${medicineId}::uuid
      AND m."genericName" ILIKE ${escapeLike(row.genericName)}
      AND s."sellable" > 0
    ORDER BY s."sellable" DESC, m."name", m."id"
    LIMIT ${MAX_SUBSTITUTES}`;
  return { medicine: toSellableDto(row), substitutes: rows.map(toSellableDto) };
}

/**
 * Active medicines whose sellable (non-expired) stock is at or below their
 * reorder level, out-of-stock first.
 */
export async function listLowStock(query: LowStockQuery): Promise<Paginated<StockSummaryDto>> {
  const today = businessToday();
  const conditions = [
    Prisma.sql`m."status" = 'ACTIVE'`,
    Prisma.sql`s."sellable" <= m."reorderLevel"`,
  ];
  if (query.categoryId) conditions.push(Prisma.sql`m."categoryId" = ${query.categoryId}::uuid`);
  const from = stockSql(today, whereSql(conditions));

  const [[{ total }], rows] = await prisma.$transaction([
    prisma.$queryRaw<[{ total: number }]>`SELECT count(*)::int AS total ${from}`,
    prisma.$queryRaw<StockRow[]>`
      SELECT ${stockColumns} ${from}
      ORDER BY s."sellable", m."name", m."id" ${pageSql(query)}`,
  ]);
  return { items: rows.map(toStockSummaryDto), total, page: query.page, pageSize: query.pageSize };
}

/**
 * Batches that still have stock, are not expired yet, and expire within
 * `days` days (inclusive), soonest first.
 */
export async function listExpiring(
  query: ExpiringStockQuery,
  viewer: Viewer,
): Promise<ExpiringStockDto> {
  const today = businessToday();
  const days = query.days ?? config.EXPIRY_WARNING_DAYS;
  const until = addDays(today, days);
  const page = await batchesWithStock(
    Prisma.sql`b."expiryDate" > ${today}::date AND b."expiryDate" <= ${until}::date`,
    query,
    today,
    viewer,
  );
  return { ...page, days, expiringOnOrBefore: until };
}

/** Expired batches that still have stock on the shelf (to be written off), oldest first. */
export function listExpired(
  query: ExpiredStockQuery,
  viewer: Viewer,
): Promise<Paginated<BatchStockDto>> {
  const today = businessToday();
  return batchesWithStock(Prisma.sql`b."expiryDate" <= ${today}::date`, query, today, viewer);
}

async function batchesWithStock(
  condition: Prisma.Sql,
  query: { page: number; pageSize: number },
  today: string,
  viewer: Viewer,
): Promise<Paginated<BatchStockDto>> {
  const where = Prisma.sql`WHERE ${condition} AND ${batchQuantitySql} > 0`;
  const [[{ total }], page] = await prisma.$transaction([
    prisma.$queryRaw<[{ total: number }]>`SELECT count(*)::int AS total FROM "Batch" b ${where}`,
    prisma.$queryRaw<{ id: string; qty: number }[]>`
      SELECT b."id", ${batchQuantitySql} AS "qty" FROM "Batch" b ${where}
      ORDER BY b."expiryDate", b."id" ${pageSql(query)}`,
  ]);

  const rows = await prisma.batch.findMany({
    where: { id: { in: page.map((p) => p.id) } },
    include: batchInclude,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = page.flatMap(({ id, qty }) => {
    const row = byId.get(id);
    return row ? [toBatchStockDto(row, qty, today, viewer)] : [];
  });
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/** The ledger itself, newest first. */
export async function listMovements(
  query: ListMovementsQuery,
): Promise<Paginated<StockMovementDto>> {
  const where: Prisma.StockMovementWhereInput = {
    batchId: query.batchId,
    type: query.type,
    ...(query.medicineId && { batch: { medicineId: query.medicineId } }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({
      where,
      include: movementInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return { items: rows.map(toMovementDto), total, page: query.page, pageSize: query.pageSize };
}
