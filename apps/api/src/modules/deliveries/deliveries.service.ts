import {
  type DeliveryBody,
  type DeliveryDto,
  type DeliveryItemDto,
  type DeliverySummaryDto,
  type ListDeliveriesQuery,
  type Paginated,
  type RejectDeliveryBody,
  type RoleCode,
} from '@pharmacy/shared';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { businessToday, fromDateOnly, toDateOnly } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { formatPaisa, sumPaisa, toPaisa } from '../../lib/money';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';
import {
  BULK_TX,
  type ItemIssue,
  checkReceipt,
  receiptDateIssues,
  receiveInTx,
} from '../inventory/inventory.service';
import { toMedicineDto } from '../medicines/medicines.service';
import { userRef } from '../sales/sales.service';

/** The signed-in user; the role decides whether a delivery needs approval. */
export type Staff = Actor & { role: RoleCode };
/** Who is reading: cashiers only see the deliveries they entered (CLAUDE.md rule 9). */
export type Viewer = { id: string; role: RoleCode };
const isApprover = (role: RoleCode) => role !== 'CASHIER';

type Db = typeof prisma | Prisma.TransactionClient;

const deliveryInclude = {
  supplier: { select: { id: true, name: true } },
  requestedBy: userRef,
  reviewedBy: userRef,
  correctedBy: userRef,
  items: {
    include: {
      medicine: { include: { category: { select: { id: true, name: true } } } },
      newCategory: { select: { id: true, name: true } },
    },
    orderBy: { lineNo: 'asc' },
  },
} satisfies Prisma.DeliveryInclude;

type DeliveryRow = Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>;
type ItemRow = DeliveryRow['items'][number];

function toItemDto(i: ItemRow): DeliveryItemDto {
  return {
    id: i.id,
    lineNo: i.lineNo,
    medicine: i.medicine && toMedicineDto(i.medicine),
    newMedicine:
      i.newName === null
        ? null
        : {
            name: i.newName,
            genericName: i.newGenericName,
            barcode: i.newBarcode,
            category: i.newCategory!,
            unit: i.newUnit!,
            reorderLevel: i.newReorderLevel!,
            sellingPrice: i.newSellingPrice!.toFixed(2),
          },
    batchNumber: i.batchNumber,
    expiryDate: toDateOnly(i.expiryDate),
    costPrice: i.costPrice.toFixed(2),
    quantity: i.quantity,
    lineCost: formatPaisa(toPaisa(i.costPrice) * BigInt(i.quantity)),
    batchId: i.batchId,
  };
}

type SummaryFields = Pick<
  DeliveryRow,
  | 'id'
  | 'status'
  | 'supplier'
  | 'invoiceNumber'
  | 'requestedBy'
  | 'createdAt'
  | 'reviewedBy'
  | 'reviewedAt'
> & { items: { quantity: number; costPrice: Prisma.Decimal; newName: string | null }[] };

function toSummaryDto(d: SummaryFields): DeliverySummaryDto {
  return {
    id: d.id,
    status: d.status,
    supplier: d.supplier,
    invoiceNumber: d.invoiceNumber,
    requestedBy: d.requestedBy,
    requestedAt: d.createdAt.toISOString(),
    reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    lineCount: d.items.length,
    units: d.items.reduce((n, i) => n + i.quantity, 0),
    totalCost: formatPaisa(sumPaisa(d.items.map((i) => toPaisa(i.costPrice) * BigInt(i.quantity)))),
    newMedicineCount: d.items.filter((i) => i.newName !== null).length,
  };
}

function toDeliveryDto(d: DeliveryRow): DeliveryDto {
  return {
    ...toSummaryDto(d),
    rejectionReason: d.rejectionReason,
    correctedBy: d.correctedBy,
    correctedAt: d.correctedAt?.toISOString() ?? null,
    items: d.items.map(toItemDto),
  };
}

async function loadDelivery(db: Db, id: string): Promise<DeliveryDto> {
  return toDeliveryDto(
    await db.delivery.findUniqueOrThrow({ where: { id }, include: deliveryInclude }),
  );
}

// ─── Checks ─────────────────────────────────────────────────────────────────

const someItems = (items: ItemIssue[]) => badRequest('Some items cannot be received', { items });

/** A proposed medicine as the checks and the catalogue need it. */
type Proposal = {
  name: string;
  genericName: string | null;
  barcode: string | null;
  categoryId: string;
  unit: string;
  reorderLevel: number;
  sellingPrice: string;
};

/** Proposed medicines need an active category and a barcode nobody else has. */
async function proposalIssues(
  tx: Prisma.TransactionClient,
  lines: { index: number; proposal: Proposal }[],
): Promise<ItemIssue[]> {
  if (lines.length === 0) return [];
  const categoryIds = [...new Set(lines.map((l) => l.proposal.categoryId))];
  const barcodes = lines.flatMap((l) => (l.proposal.barcode ? [l.proposal.barcode] : []));
  const [categories, taken] = await Promise.all([
    tx.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, status: true },
    }),
    tx.medicine.findMany({
      where: { barcode: { in: barcodes } },
      select: { barcode: true, name: true },
    }),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const owner = new Map(taken.map((m) => [m.barcode, m.name]));
  return lines.flatMap(({ index, proposal }): ItemIssue[] => {
    const issues: ItemIssue[] = [];
    const category = categoryById.get(proposal.categoryId);
    if (!category || category.status !== 'ACTIVE') {
      const message = category ? 'Category is inactive' : 'Category does not exist';
      issues.push({ index, field: 'newMedicine.categoryId', message });
    }
    const clash = proposal.barcode && owner.get(proposal.barcode);
    if (clash) {
      const message = `Barcode is already used by "${clash}"; choose that medicine instead`;
      issues.push({ index, field: 'newMedicine.barcode', message });
    }
    return issues;
  });
}

/** Everything that would stop this delivery being received today. */
async function checkDelivery(tx: Prisma.TransactionClient, input: DeliveryBody, today: string) {
  const dateIssues = receiptDateIssues(input.items, today);
  if (dateIssues.length > 0) throw someItems(dateIssues);
  await checkReceipt(
    tx,
    input.supplierId,
    input.items.map((i) => ({ ...i, medicineId: i.medicineId ?? null })),
  );
  const issues = await proposalIssues(
    tx,
    input.items.flatMap((item, index) =>
      item.newMedicine
        ? [
            {
              index,
              proposal: {
                ...item.newMedicine,
                genericName: item.newMedicine.genericName ?? null,
                barcode: item.newMedicine.barcode ?? null,
              },
            },
          ]
        : [],
    ),
  );
  if (issues.length > 0) throw someItems(issues);
}

function itemRows(input: DeliveryBody): Prisma.DeliveryItemCreateManyDeliveryInput[] {
  return input.items.map((item, index) => ({
    lineNo: index + 1,
    medicineId: item.medicineId ?? null,
    newName: item.newMedicine?.name ?? null,
    newGenericName: item.newMedicine?.genericName ?? null,
    newBarcode: item.newMedicine?.barcode ?? null,
    newCategoryId: item.newMedicine?.categoryId ?? null,
    newUnit: item.newMedicine?.unit ?? null,
    newReorderLevel: item.newMedicine?.reorderLevel ?? null,
    newSellingPrice: item.newMedicine ? new Prisma.Decimal(item.newMedicine.sellingPrice) : null,
    batchNumber: item.batchNumber,
    expiryDate: fromDateOnly(item.expiryDate),
    costPrice: new Prisma.Decimal(item.costPrice),
    quantity: item.quantity,
  }));
}

/**
 * Locks the delivery row and checks it is still PENDING, so an approval, a
 * correction and a rejection can't run over each other.
 */
async function lockPending(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Delivery" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const delivery = await tx.delivery.findUnique({
    where: { id },
    select: { status: true, requestedById: true },
  });
  if (!delivery) throw notFound('Delivery not found');
  if (delivery.status !== 'PENDING') {
    throw conflict(`This delivery is already ${delivery.status.toLowerCase()}`);
  }
  return delivery;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Records a delivery. A cashier's waits as PENDING and holds no stock; a
 * pharmacist's or admin's is received at once (CLAUDE.md rule 16).
 */
export async function createDelivery(input: DeliveryBody, staff: Staff): Promise<DeliveryDto> {
  const today = businessToday();
  return prisma.$transaction(async (tx) => {
    await checkDelivery(tx, input, today);
    const { id } = await tx.delivery.create({
      data: {
        supplierId: input.supplierId,
        invoiceNumber: input.invoiceNumber ?? null,
        requestedById: staff.id,
        items: { createMany: { data: itemRows(input) } },
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      userId: staff.id,
      action: 'DELIVERY_CREATE',
      entityType: 'Delivery',
      entityId: id,
      after: await loadDelivery(tx, id),
      meta: staff.meta,
    });
    if (isApprover(staff.role)) await approveInTx(tx, id, staff, today);
    return loadDelivery(tx, id);
  }, BULK_TX);
}

/**
 * Replaces a pending delivery with a corrected version. The cashier who
 * entered it may fix their own; approvers may correct anyone's, and are
 * named on it as having done so.
 */
export async function updateDelivery(
  id: string,
  input: DeliveryBody,
  staff: Staff,
): Promise<DeliveryDto> {
  const today = businessToday();
  return prisma.$transaction(async (tx) => {
    const found = await tx.delivery.findUnique({ where: { id }, select: { requestedById: true } });
    // A cashier gets 404, not 403, for someone else's delivery.
    if (!found || (!isApprover(staff.role) && found.requestedById !== staff.id)) {
      throw notFound('Delivery not found');
    }
    const pending = await lockPending(tx, id);
    await checkDelivery(tx, input, today);

    const before = await loadDelivery(tx, id);
    await tx.deliveryItem.deleteMany({ where: { deliveryId: id } });
    const correcting = isApprover(staff.role) && pending.requestedById !== staff.id;
    await tx.delivery.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        invoiceNumber: input.invoiceNumber ?? null,
        items: { createMany: { data: itemRows(input) } },
        ...(correcting && { correctedById: staff.id, correctedAt: new Date() }),
      },
    });
    const after = await loadDelivery(tx, id);
    await writeAudit(tx, {
      userId: staff.id,
      action: 'DELIVERY_UPDATE',
      entityType: 'Delivery',
      entityId: id,
      before,
      after,
      meta: staff.meta,
    });
    return after;
  }, BULK_TX);
}

/** Approves a cashier's delivery: its new medicines, batches and stock are created now. */
export async function approveDelivery(id: string, actor: Actor): Promise<DeliveryDto> {
  const today = businessToday();
  return prisma.$transaction(async (tx) => {
    await approveInTx(tx, id, actor, today);
    return loadDelivery(tx, id);
  }, BULK_TX);
}

async function approveInTx(
  tx: Prisma.TransactionClient,
  id: string,
  actor: Actor,
  today: string,
): Promise<void> {
  await lockPending(tx, id);
  const delivery = await tx.delivery.findUniqueOrThrow({
    where: { id },
    select: {
      supplierId: true,
      invoiceNumber: true,
      items: { orderBy: { lineNo: 'asc' } },
    },
  });
  const { items } = delivery;

  // Checked again: days have passed, and the catalogue may have changed.
  const dateIssues = receiptDateIssues(
    items.map((i) => ({ expiryDate: toDateOnly(i.expiryDate) })),
    today,
  );
  if (dateIssues.length > 0) throw someItems(dateIssues);

  // One new medicine per proposed name, however many lines (batches) it has.
  const proposed = new Map<string, { index: number; proposal: Proposal }>();
  items.forEach((i, index) => {
    if (i.medicineId !== null || i.newName === null) return;
    const key = i.newName.toLowerCase();
    if (proposed.has(key)) return;
    proposed.set(key, {
      index,
      proposal: {
        name: i.newName,
        genericName: i.newGenericName,
        barcode: i.newBarcode,
        categoryId: i.newCategoryId!,
        unit: i.newUnit!,
        reorderLevel: i.newReorderLevel!,
        sellingPrice: i.newSellingPrice!.toFixed(2),
      },
    });
  });
  const issues = await proposalIssues(tx, [...proposed.values()]);
  if (issues.length > 0) throw someItems(issues);

  const createdMedicineIds: string[] = [];
  const medicineIdByName = new Map<string, string>();
  for (const [key, { proposal }] of proposed) {
    const created = await tx.medicine.create({
      data: { ...proposal, sellingPrice: new Prisma.Decimal(proposal.sellingPrice) },
      include: { category: { select: { id: true, name: true } } },
    });
    await writeAudit(tx, {
      userId: actor.id,
      action: 'MEDICINE_CREATE',
      entityType: 'Medicine',
      entityId: created.id,
      after: { ...toMedicineDto(created), deliveryId: id },
      meta: actor.meta,
    });
    createdMedicineIds.push(created.id);
    medicineIdByName.set(key, created.id);
  }

  const lines = items.map((i) => ({
    id: i.id,
    medicineId: i.medicineId ?? medicineIdByName.get(i.newName!.toLowerCase())!,
    batchNumber: i.batchNumber,
    expiryDate: toDateOnly(i.expiryDate),
    costPrice: i.costPrice.toFixed(2),
    quantity: i.quantity,
  }));
  const batches = await receiveInTx(
    tx,
    { supplierId: delivery.supplierId, invoiceNumber: delivery.invoiceNumber, items: lines },
    actor,
    today,
  );
  for (const [n, line] of lines.entries()) {
    await tx.deliveryItem.update({
      where: { id: line.id },
      data: { medicineId: line.medicineId, batchId: batches[n]!.id },
    });
  }

  await tx.delivery.update({
    where: { id },
    data: { status: 'APPROVED', reviewedById: actor.id, reviewedAt: new Date() },
  });
  await writeAudit(tx, {
    userId: actor.id,
    action: 'DELIVERY_APPROVE',
    entityType: 'Delivery',
    entityId: id,
    before: { status: 'PENDING' },
    after: { status: 'APPROVED', batchIds: batches.map((b) => b.id), createdMedicineIds },
    meta: actor.meta,
  });
}

/** Turns down a cashier's delivery. Nothing enters stock. */
export async function rejectDelivery(
  id: string,
  input: RejectDeliveryBody,
  actor: Actor,
): Promise<DeliveryDto> {
  return prisma.$transaction(async (tx) => {
    await lockPending(tx, id);
    await tx.delivery.update({
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
      action: 'DELIVERY_REJECT',
      entityType: 'Delivery',
      entityId: id,
      before: { status: 'PENDING' },
      after: { status: 'REJECTED', reason: input.reason },
      meta: actor.meta,
    });
    return loadDelivery(tx, id);
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getDelivery(id: string, viewer: Viewer): Promise<DeliveryDto> {
  const delivery = await prisma.delivery.findUnique({ where: { id }, include: deliveryInclude });
  // A cashier gets 404, not 403, for someone else's delivery.
  if (!delivery || (!isApprover(viewer.role) && delivery.requestedById !== viewer.id)) {
    throw notFound('Delivery not found');
  }
  return toDeliveryDto(delivery);
}

const summaryInclude = {
  supplier: { select: { id: true, name: true } },
  requestedBy: userRef,
  reviewedBy: userRef,
  items: { select: { quantity: true, costPrice: true, newName: true } },
} satisfies Prisma.DeliveryInclude;

/** Deliveries newest first. Cashiers only see the ones they entered. */
export async function listDeliveries(
  query: ListDeliveriesQuery,
  viewer: Viewer,
): Promise<Paginated<DeliverySummaryDto>> {
  const term = query.q && escapeLike(query.q);
  const where: Prisma.DeliveryWhereInput = {
    status: query.status,
    supplierId: query.supplierId,
    requestedById: isApprover(viewer.role) ? query.requestedById : viewer.id,
    ...(term && {
      OR: [
        { invoiceNumber: { contains: term, mode: 'insensitive' } },
        { supplier: { name: { contains: term, mode: 'insensitive' } } },
      ],
    }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.delivery.count({ where }),
    prisma.delivery.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);
  return { items: rows.map(toSummaryDto), total, page: query.page, pageSize: query.pageSize };
}
