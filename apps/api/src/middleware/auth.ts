import type { RoleCode } from '@pharmacy/shared';
import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { verifyAccessToken } from '../modules/auth/tokens';

/**
 * Requires a valid `Authorization: Bearer <access token>`. The user's status
 * and role are re-read from the database on every request, so deactivation
 * and role changes take effect immediately rather than when the token expires.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const [scheme, token] = req.get('authorization')?.split(' ') ?? [];
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw unauthorized();
  }

  const claims = verifyAccessToken(token);
  if (!claims) throw unauthorized('Invalid or expired access token');

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, username: true, status: true, role: { select: { code: true } } },
  });
  if (!user || user.status !== 'ACTIVE') throw unauthorized('Account is not active');

  req.user = { id: user.id, username: user.username, role: user.role.code };
  next();
};

/** Who may create/edit/deactivate medicines, categories and suppliers. CASHIER is read-only. */
export const CATALOG_WRITERS = ['ADMIN', 'PHARMACIST'] as const satisfies readonly RoleCode[];

/** Allows the request only if the authenticated user has one of the given roles. */
export function requireRole(...roles: RoleCode[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}
