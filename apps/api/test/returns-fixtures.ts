import type { ReturnDto, ReturnableSaleDto } from '@pharmacy/shared';
import request from 'supertest';
import { app } from './helpers';
import { cash, saleOf, salesSetup, sell } from './sales-fixtures';

/**
 * A completed sale of 10 × Augmentin at 25.00 taken FEFO from two batches:
 * line A is 3 units of batch A, line B is 7 units of batch B (13 left in B).
 * Rung up by the cashier and paid in cash unless other payments are given.
 */
export async function returnsSetup(
  opts: { payments?: object[]; discount?: object; sellingPrice?: string } = {},
) {
  const ctx = await salesSetup();
  const m = await ctx.medicine('Augmentin 625mg', opts.sellingPrice ?? '25.00');
  const b1 = await ctx.batch(m.id, 30, 3, 'A');
  const b2 = await ctx.batch(m.id, 90, 20, 'B');
  const res = await sell(ctx.pharmacist.auth, {
    items: [{ medicineId: m.id, quantity: 10 }],
    payments: opts.payments ?? [cash('250')],
    ...(opts.discount && { discount: opts.discount }),
  });
  if (res.status !== 201) throw new Error(`Setup sale failed: ${JSON.stringify(res.body)}`);
  const sale = saleOf(res);
  return { ...ctx, m, b1, b2, sale, lineA: sale.items[0]!, lineB: sale.items[1]! };
}

type ReturnBody = {
  saleId: string;
  items: { saleItemId: string; quantity: number; restock?: boolean }[];
  reason?: string;
  refunds?: object[];
  [key: string]: unknown;
};

export function createReturn(auth: string, body: ReturnBody) {
  return request(app)
    .post('/api/returns')
    .set('Authorization', auth)
    .send({ reason: 'Customer returned unopened pack', ...body });
}

export function approveReturn(auth: string, id: string) {
  return request(app).post(`/api/returns/${id}/approve`).set('Authorization', auth).send({});
}

export function rejectReturn(auth: string, id: string, reason = 'Pack has been opened') {
  return request(app).post(`/api/returns/${id}/reject`).set('Authorization', auth).send({ reason });
}

export function getReturn(auth: string, id: string) {
  return request(app).get(`/api/returns/${id}`).set('Authorization', auth);
}

export function listReturns(auth: string, query: Record<string, string | number> = {}) {
  return request(app).get('/api/returns').set('Authorization', auth).query(query);
}

export function returnable(auth: string, query: { saleId?: string; receiptNumber?: string }) {
  return request(app).get('/api/returns/returnable').set('Authorization', auth).query(query);
}

/** Typed views of Supertest response bodies, which are `any`. */
export const returnOf = (res: request.Response) => (res.body as { return: ReturnDto }).return;
export const returnableOf = (res: request.Response) => res.body as ReturnableSaleDto;
