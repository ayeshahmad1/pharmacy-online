import type { UserDto } from '@pharmacy/shared';
import type { Prisma } from '@prisma/client';

/** Prisma select for everything a UserDto needs. Never selects passwordHash. */
export const userDtoSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { code: true } },
} satisfies Prisma.UserSelect;

export type UserRow = Prisma.UserGetPayload<{ select: typeof userDtoSelect }>;

export function toUserDto(user: UserRow): UserDto {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    role: user.role.code,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
