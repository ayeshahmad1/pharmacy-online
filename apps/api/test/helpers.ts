import { ROLE_CODES, type RoleCode } from '@pharmacy/shared';
import type { RecordStatus } from '@prisma/client';
import request from 'supertest';
import { createApp } from '../src/app';
import { addDays, businessToday, fromDateOnly } from '../src/lib/dates';
import { hashPassword } from '../src/lib/password';
import { prisma } from '../src/lib/prisma';
import { REFRESH_COOKIE } from '../src/modules/auth/auth.controller';

export const app = createApp();
export const DEFAULT_PASSWORD = 'Counter#2026';

/** Empties every table (except migration history) and re-creates the roles. */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
  await prisma.role.createMany({ data: ROLE_CODES.map((code) => ({ code, name: code })) });
}

export async function createUser(opts: {
  role: RoleCode;
  username?: string;
  password?: string;
  status?: RecordStatus;
}) {
  const username = opts.username ?? opts.role.toLowerCase();
  return prisma.user.create({
    data: {
      username,
      fullName: `Test ${username}`,
      passwordHash: await hashPassword(opts.password ?? DEFAULT_PASSWORD),
      status: opts.status ?? 'ACTIVE',
      role: { connect: { code: opts.role } },
    },
  });
}

/** The `name=value` part of the refresh Set-Cookie header, ready to send back. */
export function refreshCookieFrom(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  return cookie?.split(';')[0];
}

export async function login(username: string, password = DEFAULT_PASSWORD) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  return {
    res,
    accessToken: (res.body as { accessToken: string }).accessToken,
    refreshCookie: refreshCookieFrom(res)!,
  };
}

/** Creates a user with the role and returns a ready-to-use bearer header. */
export async function authAs(role: RoleCode, username?: string) {
  const user = await createUser({ role, username });
  const { accessToken } = await login(user.username);
  return { user, auth: `Bearer ${accessToken}` };
}

export function auditEntries(action: string) {
  return prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
}

export function createCategory(name = 'Tablets', status: RecordStatus = 'ACTIVE') {
  return prisma.category.create({ data: { name, status } });
}

export function createSupplier(name = 'Pak Pharma Distributors', status: RecordStatus = 'ACTIVE') {
  return prisma.supplier.create({ data: { name, status } });
}

export function createMedicine(opts: {
  name: string;
  categoryId: string;
  genericName?: string | null;
  barcode?: string | null;
  status?: RecordStatus;
  sellingPrice?: string;
}) {
  return prisma.medicine.create({
    data: {
      name: opts.name,
      genericName: opts.genericName ?? null,
      barcode: opts.barcode ?? null,
      categoryId: opts.categoryId,
      unit: 'tablet',
      sellingPrice: opts.sellingPrice ?? '10.00',
      status: opts.status ?? 'ACTIVE',
    },
  });
}

/** "YYYY-MM-DD" that many days from today in the pharmacy's timezone (negative = past). */
export const daysFromToday = (days: number) => addDays(businessToday(), days);

/**
 * Inserts a batch and its PURCHASE movement straight into the database. Lets
 * tests set up stock the API would refuse to receive, such as expired batches.
 */
export async function createBatch(opts: {
  medicineId: string;
  supplierId: string;
  userId: string;
  expiryDate: string;
  quantity: number;
  batchNumber?: string;
  costPrice?: string;
}) {
  const batch = await prisma.batch.create({
    data: {
      medicineId: opts.medicineId,
      supplierId: opts.supplierId,
      batchNumber: opts.batchNumber ?? `B-${opts.expiryDate}-${opts.quantity}`,
      expiryDate: fromDateOnly(opts.expiryDate),
      costPrice: opts.costPrice ?? '5.00',
      quantityReceived: opts.quantity,
    },
  });
  await prisma.stockMovement.create({
    data: { batchId: batch.id, type: 'PURCHASE', quantity: opts.quantity, userId: opts.userId },
  });
  return batch;
}

/** Stock of a batch straight from the ledger, bypassing the API. */
export async function ledgerQuantity(batchId: string): Promise<number> {
  const { _sum } = await prisma.stockMovement.aggregate({
    where: { batchId },
    _sum: { quantity: true },
  });
  return _sum.quantity ?? 0;
}
