import type {
  CreateUserBody,
  ListUsersQuery,
  Paginated,
  UpdateUserBody,
  UserDto,
} from '@pharmacy/shared';
import type { Prisma, RecordStatus } from '@prisma/client';
import { type RequestMeta, writeAudit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { revokeAllRefreshTokens } from '../auth/auth.service';
import { toUserDto, userDtoSelect } from './user.dto';

/** The admin performing the action, for self-protection checks and the audit log. */
export type Actor = { id: string; meta: RequestMeta };

export async function listUsers(query: ListUsersQuery): Promise<Paginated<UserDto>> {
  const where: Prisma.UserWhereInput = {
    ...(query.role && { role: { code: query.role } }),
    ...(query.status && { status: query.status }),
    ...(query.q && {
      OR: [
        { username: { contains: query.q, mode: 'insensitive' } },
        { fullName: { contains: query.q, mode: 'insensitive' } },
      ],
    }),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: userDtoSelect,
      orderBy: { username: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { items: rows.map(toUserDto), total, page: query.page, pageSize: query.pageSize };
}

export async function getUser(id: string): Promise<UserDto> {
  const user = await prisma.user.findUnique({ where: { id }, select: userDtoSelect });
  if (!user) throw notFound('User not found');
  return toUserDto(user);
}

export async function createUser(input: CreateUserBody, actor: Actor): Promise<UserDto> {
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        username: input.username,
        fullName: input.fullName,
        email: input.email ?? null,
        passwordHash,
        role: { connect: { code: input.role } },
      },
      select: userDtoSelect,
    });
    const dto = toUserDto(created);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'USER_CREATE',
      entityType: 'User',
      entityId: dto.id,
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

export async function updateUser(
  id: string,
  input: UpdateUserBody,
  actor: Actor,
): Promise<UserDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);

    // An admin who demotes themselves could leave the pharmacy with no admin.
    if (id === actor.id && input.role !== undefined && input.role !== before.role.code) {
      throw badRequest('You cannot change your own role');
    }

    const updated = await tx.user.update({
      where: { id },
      data: {
        fullName: input.fullName,
        email: input.email,
        ...(input.role && { role: { connect: { code: input.role } } }),
      },
      select: userDtoSelect,
    });
    const dto = toUserDto(updated);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'USER_UPDATE',
      entityType: 'User',
      entityId: id,
      before: toUserDto(before),
      after: dto,
      meta: actor.meta,
    });
    return dto;
  });
}

export async function deactivateUser(id: string, actor: Actor): Promise<UserDto> {
  // Self-deactivation is blocked, so there is always at least one active admin.
  if (id === actor.id) throw badRequest('You cannot deactivate your own account');
  return setStatus(id, 'INACTIVE', actor);
}

export async function activateUser(id: string, actor: Actor): Promise<UserDto> {
  return setStatus(id, 'ACTIVE', actor);
}

export async function resetPassword(id: string, newPassword: string, actor: Actor): Promise<void> {
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await findOrThrow(tx, id);
    await tx.user.update({ where: { id }, data: { passwordHash } });
    // Sign the user out everywhere: whoever knew the old password loses access.
    await revokeAllRefreshTokens(tx, id);
    await writeAudit(tx, {
      userId: actor.id,
      action: 'USER_PASSWORD_RESET',
      entityType: 'User',
      entityId: id,
      meta: actor.meta,
    });
  });
}

async function setStatus(id: string, status: RecordStatus, actor: Actor): Promise<UserDto> {
  return prisma.$transaction(async (tx) => {
    const before = await findOrThrow(tx, id);
    if (before.status === status) return toUserDto(before);

    const updated = await tx.user.update({
      where: { id },
      data: { status },
      select: userDtoSelect,
    });
    if (status === 'INACTIVE') await revokeAllRefreshTokens(tx, id);

    const dto = toUserDto(updated);
    await writeAudit(tx, {
      userId: actor.id,
      action: status === 'INACTIVE' ? 'USER_DEACTIVATE' : 'USER_ACTIVATE',
      entityType: 'User',
      entityId: id,
      before: { status: before.status },
      after: { status: dto.status },
      meta: actor.meta,
    });
    return dto;
  });
}

async function findOrThrow(tx: Prisma.TransactionClient, id: string) {
  const user = await tx.user.findUnique({ where: { id }, select: userDtoSelect });
  if (!user) throw notFound('User not found');
  return user;
}
