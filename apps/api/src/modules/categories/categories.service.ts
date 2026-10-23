import type {
  CategoryDto,
  CreateCategoryBody,
  ListCategoriesQuery,
  Paginated,
  UpdateCategoryBody,
} from '@pharmacy/shared';
import type { Category, Prisma, RecordStatus } from '@prisma/client';
import type { Actor } from '../../lib/actor';
import { writeAudit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { escapeLike } from '../../lib/search';

export function toCategoryDto(c: Category): CategoryDto {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function listCategories(query: ListCategoriesQuery): Promise<Paginated<CategoryDto>> {
  const where: Prisma.CategoryWhereInput = {
    ...(query.status && { status: query.status }),
    ...(query.q && { name: { contains: escapeLike(query.q), mode: 'insensitive' } }),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.category.count({ where }),
    prisma.category.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { items: rows.map(toCategoryDto), total, page: query.page, pageSize: query.pageSize };
}

export async function getCategory(id: string): Promise<CategoryDto> {
  return toCategoryDto(await findOrThrow(prisma, id));
}

export async function createCategory(
  input: CreateCategoryBody,
  actor: Actor,
): Promise<CategoryDto> {
  return prisma.$transaction(async (tx) => {
    await assertNameFree(tx, input.name);
    const created = await tx.category.create({
      data: { name: input.name, description: input.description ?? null },
    });
    const dto = toCategoryDto(created);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'CATEGORY_CREATE',
      entityType: 'Category',
      entityId: dto.id,
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

export async function updateCategory(
  id: string,
  input: UpdateCategoryBody,
  actor: Actor,
): Promise<CategoryDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (input.name !== undefined) await assertNameFree(tx, input.name, id);

    const updated = await tx.category.update({
      where: { id },
      data: { name: input.name, description: input.description },
    });
    const dto = toCategoryDto(updated);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'CATEGORY_UPDATE',
      entityType: 'Category',
      entityId: id,
      before: toCategoryDto(before),
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

/**
 * Hides the category from pickers. Its medicines keep it (history stays
 * intact), but no medicine can be newly assigned to it while inactive.
 */
export function deactivateCategory(id: string, actor: Actor) {
  return setStatus(id, 'INACTIVE', actor);
}

export function activateCategory(id: string, actor: Actor) {
  return setStatus(id, 'ACTIVE', actor);
}

async function setStatus(id: string, status: RecordStatus, actor: Actor): Promise<CategoryDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (before.status === status) return toCategoryDto(before);

    const dto = toCategoryDto(await tx.category.update({ where: { id }, data: { status } }));
    await writeAudit(tx, {
      userId: actor.id,
      action: status === 'INACTIVE' ? 'CATEGORY_DEACTIVATE' : 'CATEGORY_ACTIVATE',
      entityType: 'Category',
      entityId: id,
      before: { status: before.status },
      after: { status: dto.status },
      meta: actor.meta,
    });
    return dto;
  });
}

// The unique index is case-sensitive; "Tablets" and "tablets" are still the
// same category to a person, so check case-insensitively first.
async function assertNameFree(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
  const clash = await tx.category.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId && { NOT: { id: exceptId } }),
    },
    select: { id: true, name: true },
  });
  if (clash) throw conflict(`A category named "${clash.name}" already exists`, { field: 'name' });
}

async function findOrThrow(db: Prisma.TransactionClient, id: string) {
  const category = await db.category.findUnique({ where: { id } });
  if (!category) throw notFound('Category not found');
  return category;
}
