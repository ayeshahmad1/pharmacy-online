import type {
  CreateSupplierBody,
  ListSuppliersQuery,
  Paginated,
  SupplierDto,
  UpdateSupplierBody,
} from '@pharmacy/shared';
import type { Prisma, RecordStatus, Supplier } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';

export function toSupplierDto(s: Supplier): SupplierDto {
  return {
    id: s.id,
    name: s.name,
    contactPerson: s.contactPerson,
    phone: s.phone,
    email: s.email,
    address: s.address,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function listSuppliers(query: ListSuppliersQuery): Promise<Paginated<SupplierDto>> {
  const term = query.q && escapeLike(query.q);
  const where: Prisma.SupplierWhereInput = {
    ...(query.status && { status: query.status }),
    ...(term && {
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { contactPerson: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
      ],
    }),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.supplier.count({ where }),
    prisma.supplier.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { items: rows.map(toSupplierDto), total, page: query.page, pageSize: query.pageSize };
}

export async function getSupplier(id: string): Promise<SupplierDto> {
  return toSupplierDto(await findOrThrow(prisma, id));
}

export async function createSupplier(
  input: CreateSupplierBody,
  actor: Actor,
): Promise<SupplierDto> {
  return prisma.$transaction(async (tx) => {
    await assertNameFree(tx, input.name);
    const created = await tx.supplier.create({
      data: {
        name: input.name,
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
      },
    });
    const dto = toSupplierDto(created);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'SUPPLIER_CREATE',
      entityType: 'Supplier',
      entityId: dto.id,
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

export async function updateSupplier(
  id: string,
  input: UpdateSupplierBody,
  actor: Actor,
): Promise<SupplierDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (input.name !== undefined) await assertNameFree(tx, input.name, id);

    const updated = await tx.supplier.update({
      where: { id },
      data: {
        name: input.name,
        contactPerson: input.contactPerson,
        phone: input.phone,
        email: input.email,
        address: input.address,
      },
    });
    const dto = toSupplierDto(updated);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'SUPPLIER_UPDATE',
      entityType: 'Supplier',
      entityId: id,
      before: toSupplierDto(before),
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

/** Hides the supplier from pickers. Existing batches keep pointing at it. */
export function deactivateSupplier(id: string, actor: Actor) {
  return setStatus(id, 'INACTIVE', actor);
}

export function activateSupplier(id: string, actor: Actor) {
  return setStatus(id, 'ACTIVE', actor);
}

async function setStatus(id: string, status: RecordStatus, actor: Actor): Promise<SupplierDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (before.status === status) return toSupplierDto(before);

    const dto = toSupplierDto(await tx.supplier.update({ where: { id }, data: { status } }));
    await writeAudit(tx, {
      userId: actor.id,
      action: status === 'INACTIVE' ? 'SUPPLIER_DEACTIVATE' : 'SUPPLIER_ACTIVATE',
      entityType: 'Supplier',
      entityId: id,
      before: { status: before.status },
      after: { status: dto.status },
      meta: actor.meta,
    });
    return dto;
  });
}

// The unique index is case-sensitive, so check case-insensitively first.
async function assertNameFree(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
  const clash = await tx.supplier.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId && { NOT: { id: exceptId } }),
    },
    select: { id: true, name: true },
  });
  if (clash) throw conflict(`A supplier named "${clash.name}" already exists`, { field: 'name' });
}

async function findOrThrow(db: Prisma.TransactionClient, id: string) {
  const supplier = await db.supplier.findUnique({ where: { id } });
  if (!supplier) throw notFound('Supplier not found');
  return supplier;
}
