import { randomUUID } from 'node:crypto';
import type { LoginBody, UserDto } from '@pharmacy/shared';
import type { Prisma } from '@prisma/client';
import { type RequestMeta, writeAudit } from '../../lib/audit';
import { config } from '../../lib/config';
import { AppError } from '../../lib/errors';
import { burnPasswordCheck, verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { toUserDto, userDtoSelect } from '../users/user.dto';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens';

/**
 * A rotated token presented again within this window is treated as a benign
 * race (two tabs refreshing at once) and just rejected. Later than that, it is
 * treated as theft and the whole token family is revoked.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

export type AuthResult = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: UserDto;
};

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');

const invalidRefreshToken = () =>
  new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session expired, please log in again');

export async function login(input: LoginBody, meta: RequestMeta): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { username: input.username },
    select: { ...userDtoSelect, passwordHash: true },
  });

  // Failed attempts are audited outside any transaction so they always persist.
  if (!user) {
    await burnPasswordCheck(input.password);
    await writeAudit(prisma, {
      userId: null,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'User',
      after: { username: input.username, reason: 'UNKNOWN_USER' },
      meta,
    });
    throw invalidCredentials();
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    await writeAudit(prisma, {
      userId: user.id,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'User',
      entityId: user.id,
      after: { reason: 'WRONG_PASSWORD' },
      meta,
    });
    throw invalidCredentials();
  }

  // Only revealed after a correct password, so it can't be used to probe accounts.
  if (user.status !== 'ACTIVE') {
    await writeAudit(prisma, {
      userId: user.id,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'User',
      entityId: user.id,
      after: { reason: 'ACCOUNT_INACTIVE' },
      meta,
    });
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
      select: userDtoSelect,
    });
    const refresh = await issueRefreshToken(tx, user.id, randomUUID(), meta);
    await writeAudit(tx, {
      userId: user.id,
      action: 'AUTH_LOGIN',
      entityType: 'User',
      entityId: user.id,
      meta,
    });
    return buildResult(toUserDto(updated), refresh);
  });
}

/** Exchanges a refresh token for a new access token and a rotated refresh token. */
export async function refresh(rawToken: string, meta: RequestMeta): Promise<AuthResult> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    include: { user: { select: userDtoSelect } },
  });
  if (!stored) throw invalidRefreshToken();

  if (stored.revokedAt) {
    // Only a token revoked by rotation signals theft. One revoked by logout,
    // deactivation or a previous family revocation is simply dead.
    const replayedAfterGrace =
      stored.replacedById !== null &&
      Date.now() - stored.revokedAt.getTime() >= REFRESH_REUSE_GRACE_MS;
    if (replayedAfterGrace) await revokeFamilyOnReuse(stored, meta);
    throw invalidRefreshToken();
  }

  if (stored.expiresAt <= new Date() || stored.user.status !== 'ACTIVE') {
    throw invalidRefreshToken();
  }

  return prisma.$transaction(async (tx) => {
    const next = await issueRefreshToken(tx, stored.userId, stored.familyId, meta);
    // Conditional update: if a concurrent request rotated this token first,
    // nothing matches and this request loses the race.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: next.id },
    });
    if (count === 0) throw invalidRefreshToken();
    return buildResult(toUserDto(stored.user), next);
  });
}

/** Revokes the given refresh token. Safe to call with an unknown or revoked token. */
export async function logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (!rawToken) return;
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!stored || stored.revokedAt) return;

  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    await writeAudit(tx, {
      userId: stored.userId,
      action: 'AUTH_LOGOUT',
      entityType: 'User',
      entityId: stored.userId,
      meta,
    });
  });
}

/** Revokes every active refresh token of a user (deactivation, password reset). */
export async function revokeAllRefreshTokens(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function revokeFamilyOnReuse(
  stored: { id: string; userId: string; familyId: string },
  meta: RequestMeta,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(tx, {
      userId: stored.userId,
      action: 'AUTH_REFRESH_REUSE',
      entityType: 'RefreshToken',
      entityId: stored.id,
      after: { familyId: stored.familyId },
      meta,
    });
  });
}

async function issueRefreshToken(
  tx: Prisma.TransactionClient,
  userId: string,
  familyId: string,
  meta: RequestMeta,
) {
  const raw = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const row = await tx.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashRefreshToken(raw),
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    select: { id: true },
  });
  return { id: row.id, raw, expiresAt };
}

function buildResult(user: UserDto, refresh: { raw: string; expiresAt: Date }): AuthResult {
  return {
    accessToken: signAccessToken(user),
    expiresIn: config.JWT_ACCESS_TTL_SECONDS,
    refreshToken: refresh.raw,
    refreshTokenExpiresAt: refresh.expiresAt,
    user,
  };
}
