import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';

export const AUDIT_ACTIONS = [
  'AUTH_LOGIN',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',
  'AUTH_REFRESH_REUSE',
  'USER_CREATE',
  'USER_UPDATE',
  'USER_DEACTIVATE',
  'USER_ACTIVATE',
  'USER_PASSWORD_RESET',
  'CATEGORY_CREATE',
  'CATEGORY_UPDATE',
  'CATEGORY_DEACTIVATE',
  'CATEGORY_ACTIVATE',
  'SUPPLIER_CREATE',
  'SUPPLIER_UPDATE',
  'SUPPLIER_DEACTIVATE',
  'SUPPLIER_ACTIVATE',
  'MEDICINE_CREATE',
  'MEDICINE_UPDATE',
  'MEDICINE_DEACTIVATE',
  'MEDICINE_ACTIVATE',
  'STOCK_RECEIVE',
  'STOCK_ADJUST',
  'STOCK_EXPIRED_WRITEOFF',
  'SALE_CREATE',
  'SALE_VOID',
  'RETURN_CREATE',
  'RETURN_APPROVE',
  'RETURN_REJECT',
  'OFFLINE_SALE_REPORT',
  'OFFLINE_SALE_RETRY',
  'OFFLINE_SALE_DISMISS',
  'ALERTS_REFRESH',
  'ALERT_ACKNOWLEDGE',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type RequestMeta = { ipAddress: string | null; userAgent: string | null };

export type AuditEntry = {
  /** Who did it. Null for system actions or an unidentified actor. */
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: RequestMeta;
};

/** Either the root client or the client of an open $transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Writes one AuditLog row. Pass the transaction client when the audited change
 * runs in a transaction, so the change and its audit entry commit together.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: toAuditJson(entry.before),
      after: toAuditJson(entry.after),
      ipAddress: entry.meta?.ipAddress ?? null,
      userAgent: entry.meta?.userAgent ?? null,
    },
  });
}

export function requestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
  };
}

// Keys whose values must never reach the audit log, at any depth.
const SECRET_KEY = /password|token|secret/i;

/**
 * Converts a value to plain JSON (Dates and Decimals become strings) and drops
 * secret-looking keys as a safety net for callers.
 */
export function toAuditJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value, (key, v: unknown) =>
    key !== '' && SECRET_KEY.test(key) ? undefined : v,
  );
  return JSON.parse(json) as Prisma.InputJsonValue;
}
