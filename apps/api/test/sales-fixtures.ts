import { randomUUID } from 'node:crypto';
import type { Paginated, SaleDto, SaleSummaryDto } from '@pharmacy/shared';
import request from 'supertest';
import { businessToday } from '../src/lib/dates';
import {
  app,
  authAs,
  createBatch,
  createCategory,
  createMedicine,
  createSupplier,
  daysFromToday,
} from './helpers';

/** A pharmacist, a cashier, and factories for medicines and their batches. */
export async function salesSetup() {
  const pharmacist = await authAs('PHARMACIST');
  const cashier = await authAs('CASHIER');
  const category = await createCategory();
  const supplier = await createSupplier();

  const medicine = (name: string, sellingPrice = '10.00') =>
    createMedicine({ name, categoryId: category.id, sellingPrice });

  /** A batch expiring `expiryInDays` from today (0 or less = already expired). */
  const batch = (
    medicineId: string,
    expiryInDays: number,
    quantity: number,
    batchNumber?: string,
  ) =>
    createBatch({
      medicineId,
      supplierId: supplier.id,
      userId: pharmacist.user.id,
      expiryDate: daysFromToday(expiryInDays),
      quantity,
      batchNumber,
    });

  return { pharmacist, cashier, category, supplier, medicine, batch };
}

// Extra keys allowed so tests can send fields the API must refuse.
type Line = { medicineId: string; quantity: number; [key: string]: unknown };

/** POST /api/sales with a fresh idempotency key unless one is given. */
export function sell(
  auth: string,
  body: { items: Line[]; payments?: object[]; [k: string]: unknown },
) {
  return request(app)
    .post('/api/sales')
    .set('Authorization', auth)
    .send({ idempotencyKey: randomUUID(), payments: [], ...body });
}

export const cash = (amount: string) => ({ method: 'CASH', amount });
export const card = (amount: string, reference = 'AUTH-1') => ({
  method: 'CARD',
  amount,
  reference,
});
export const wallet = (amount: string, reference = 'JC-1') => ({
  method: 'MOBILE_WALLET',
  amount,
  reference,
});

/** The receipt number the n-th sale of today should get. */
export const receiptNo = (n: number) =>
  `S-${businessToday().replace(/-/g, '')}-${String(n).padStart(4, '0')}`;

export function voidSale(auth: string, id: string, reason = 'Customer changed their mind') {
  return request(app).post(`/api/sales/${id}/void`).set('Authorization', auth).send({ reason });
}

export function getSale(auth: string, id: string) {
  return request(app).get(`/api/sales/${id}`).set('Authorization', auth);
}

export function listSales(auth: string, query: Record<string, string | number> = {}) {
  return request(app).get('/api/sales').set('Authorization', auth).query(query);
}

/** Typed views of Supertest response bodies, which are `any`. */
export const saleOf = (res: request.Response) => (res.body as { sale: SaleDto }).sale;
export const idsOf = (res: request.Response) =>
  (res.body as Paginated<SaleSummaryDto>).items.map((s) => s.id);
