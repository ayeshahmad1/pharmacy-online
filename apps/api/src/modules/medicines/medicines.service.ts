import type {
  CreateMedicineBody,
  ListMedicinesQuery,
  MedicineDto,
  Paginated,
  UpdateMedicineBody,
} from '@pharmacy/shared';
import { Prisma, type RecordStatus } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';

const medicineInclude = {
  category: { select: { id: true, name: true } },
} satisfies Prisma.MedicineInclude;

type MedicineRow = Prisma.MedicineGetPayload<{ include: typeof medicineInclude }>;

export function toMedicineDto(m: MedicineRow): MedicineDto {
  return {
    id: m.id,
    name: m.name,
    genericName: m.genericName,
    barcode: m.barcode,
    category: { id: m.category.id, name: m.category.name },
    unit: m.unit,
    reorderLevel: m.reorderLevel,
    sellingPrice: m.sellingPrice.toFixed(2),
    status: m.status,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/**
 * Search goes through raw SQL because Prisma can't order by relevance. The
 * ILIKE '%term%' predicates are served by the pg_trgm GIN indexes on name and
 * genericName. Only ids are fetched here; rows come from Prisma afterwards so
 * the DTO mapping stays typed.
 */
export async function listMedicines(query: ListMedicinesQuery): Promise<Paginated<MedicineDto>> {
  const conditions: Prisma.Sql[] = [];
  if (query.status) conditions.push(Prisma.sql`m."status" = ${query.status}::"RecordStatus"`);
  if (query.categoryId) conditions.push(Prisma.sql`m."categoryId" = ${query.categoryId}::uuid`);

  // Without a search term this stays empty: a bare `ORDER BY 0` would be read
  // as a column position.
  let rank = Prisma.empty;
  if (query.q) {
    const term = escapeLike(query.q);
    const contains = `%${term}%`;
    const prefix = `${term}%`;
    conditions.push(Prisma.sql`(m."name" ILIKE ${contains} OR m."genericName" ILIKE ${contains})`);
    // Exact name first, then brand-name prefix, then generic prefix, then the rest.
    rank = Prisma.sql`CASE
      WHEN m."name" ILIKE ${term} THEN 0
      WHEN m."name" ILIKE ${prefix} THEN 1
      WHEN m."genericName" ILIKE ${prefix} THEN 2
      ELSE 3 END,`;
  }
  const where = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;

  const [[{ total }], page] = await prisma.$transaction([
    prisma.$queryRaw<[{ total: number }]>`SELECT count(*)::int AS total FROM "Medicine" m ${where}`,
    prisma.$queryRaw<{ id: string }[]>`
      SELECT m."id" FROM "Medicine" m ${where}
      ORDER BY ${rank} m."name", m."id"
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
  ]);

  const ids = page.map((r) => r.id);
  const rows = await prisma.medicine.findMany({
    where: { id: { in: ids } },
    include: medicineInclude,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toMedicineDto(row)] : [];
  });

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getMedicine(id: string): Promise<MedicineDto> {
  return toMedicineDto(await findOrThrow(prisma, id));
}

export async function createMedicine(
  input: CreateMedicineBody,
  actor: Actor,
): Promise<MedicineDto> {
  return prisma.$transaction(async (tx) => {
    await assertCategoryUsable(tx, input.categoryId);
    if (input.barcode) await assertBarcodeFree(tx, input.barcode);

    const created = await tx.medicine.create({
      data: {
        name: input.name,
        genericName: input.genericName ?? null,
        barcode: input.barcode ?? null,
        categoryId: input.categoryId,
        unit: input.unit,
        reorderLevel: input.reorderLevel,
        sellingPrice: new Prisma.Decimal(input.sellingPrice),
      },
      include: medicineInclude,
    });
    const dto = toMedicineDto(created);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'MEDICINE_CREATE',
      entityType: 'Medicine',
      entityId: dto.id,
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

export async function updateMedicine(
  id: string,
  input: UpdateMedicineBody,
  actor: Actor,
): Promise<MedicineDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (input.categoryId !== undefined && input.categoryId !== before.categoryId) {
      await assertCategoryUsable(tx, input.categoryId);
    }
    if (input.barcode) await assertBarcodeFree(tx, input.barcode, id);

    const updated = await tx.medicine.update({
      where: { id },
      data: {
        name: input.name,
        genericName: input.genericName,
        barcode: input.barcode,
        categoryId: input.categoryId,
        unit: input.unit,
        reorderLevel: input.reorderLevel,
        sellingPrice:
          input.sellingPrice === undefined ? undefined : new Prisma.Decimal(input.sellingPrice),
      },
      include: medicineInclude,
    });
    const dto = toMedicineDto(updated);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'MEDICINE_UPDATE',
      entityType: 'Medicine',
      entityId: id,
      before: toMedicineDto(before),
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

/** Inactive medicines stay in history and reports but are hidden from billing. */
export function deactivateMedicine(id: string, actor: Actor) {
  return setStatus(id, 'INACTIVE', actor);
}

export function activateMedicine(id: string, actor: Actor) {
  return setStatus(id, 'ACTIVE', actor);
}

async function setStatus(id: string, status: RecordStatus, actor: Actor): Promise<MedicineDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (before.status === status) return toMedicineDto(before);

    const dto = toMedicineDto(
      await tx.medicine.update({ where: { id }, data: { status }, include: medicineInclude }),
    );
    await writeAudit(tx, {
      userId: actor.id,
      action: status === 'INACTIVE' ? 'MEDICINE_DEACTIVATE' : 'MEDICINE_ACTIVATE',
      entityType: 'Medicine',
      entityId: id,
      before: { status: before.status },
      after: { status: dto.status },
      meta: actor.meta,
    });
    return dto;
  });
}

async function assertCategoryUsable(tx: Prisma.TransactionClient, categoryId: string) {
  const category = await tx.category.findUnique({
    where: { id: categoryId },
    select: { status: true },
  });
  if (!category) throw badRequest('Category does not exist', { field: 'categoryId' });
  if (category.status !== 'ACTIVE') {
    throw badRequest('Category is inactive', { field: 'categoryId' });
  }
}

// The unique index is the real guarantee; this just gives a clearer message.
async function assertBarcodeFree(tx: Prisma.TransactionClient, barcode: string, exceptId?: string) {
  const clash = await tx.medicine.findFirst({
    where: { barcode, ...(exceptId && { NOT: { id: exceptId } }) },
    select: { name: true },
  });
  if (clash) {
    throw conflict(`Barcode is already used by "${clash.name}"`, { field: 'barcode' });
  }
}

async function findOrThrow(db: Prisma.TransactionClient, id: string) {
  const medicine = await db.medicine.findUnique({ where: { id }, include: medicineInclude });
  if (!medicine) throw notFound('Medicine not found');
  return medicine;
}
