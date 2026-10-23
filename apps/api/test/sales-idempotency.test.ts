import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { auditEntries, authAs, ledgerQuantity, resetDatabase } from './helpers';
import { cash, saleOf, salesSetup, sell, voidSale } from './sales-fixtures';

beforeEach(resetDatabase);

async function setup(quantity = 10) {
  const ctx = await salesSetup();
  const m = await ctx.medicine('Panadol 500mg');
  const b = await ctx.batch(m.id, 30, quantity);
  const cart = (key = randomUUID(), quantity = 1) => ({
    idempotencyKey: key,
    items: [{ medicineId: m.id, quantity }],
    payments: [cash('50')],
  });
  return { ...ctx, m, b, cart };
}

describe('idempotency keys', () => {
  it('returns the original sale for a retried request instead of selling twice', async () => {
    const { cashier, b, cart } = await setup();
    const body = cart(randomUUID(), 2);

    const first = await sell(cashier.auth, body);
    const retry = await sell(cashier.auth, body);

    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.sale).toEqual(first.body.sale);

    expect(await prisma.sale.count()).toBe(1);
    expect(await ledgerQuantity(b.id)).toBe(8);
    expect(await auditEntries('SALE_CREATE')).toHaveLength(1);
    expect(await prisma.receiptCounter.findFirst()).toMatchObject({ lastNumber: 1 });
  });

  it('replays even after the stock it took has run out', async () => {
    const { cashier, cart } = await setup(1);
    const body = cart();
    expect((await sell(cashier.auth, body)).status).toBe(201);

    const retry = await sell(cashier.auth, body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
  });

  it('saves one sale when the same request arrives twice at the same time', async () => {
    const { cashier, b, cart } = await setup();
    const body = cart();

    const responses = await Promise.all([sell(cashier.auth, body), sell(cashier.auth, body)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(saleOf(responses[0]).id).toBe(saleOf(responses[1]).id);
    expect(await prisma.sale.count()).toBe(1);
    expect(await ledgerQuantity(b.id)).toBe(9);
  });

  it('saves one sale for a burst of retries', async () => {
    const { cashier, b, cart } = await setup();
    const body = cart();

    const responses = await Promise.all(Array.from({ length: 6 }, () => sell(cashier.auth, body)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
    expect(new Set(responses.map((r) => saleOf(r).id)).size).toBe(1);
    expect(await ledgerQuantity(b.id)).toBe(9);
  });

  it('rejects the same key with a different cart', async () => {
    const { cashier, b, cart } = await setup();
    const key = randomUUID();
    await sell(cashier.auth, cart(key, 1));

    const res = await sell(cashier.auth, cart(key, 3));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.sale.count()).toBe(1);
    expect(await ledgerQuantity(b.id)).toBe(9);
  });

  it("rejects another user's key without revealing their sale", async () => {
    const { cashier, cart } = await setup();
    const other = await authAs('CASHIER', 'cashier2');
    const body = cart();
    await sell(cashier.auth, body);

    const res = await sell(other.auth, body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(res.body.sale).toBeUndefined();
  });

  it('does not use up the key when the sale is rejected, so it can be retried', async () => {
    const { cashier, m, batch, cart } = await setup(1);
    const body = cart(randomUUID(), 3);

    const rejected = await sell(cashier.auth, body);
    expect(rejected.status).toBe(409);

    // Stock arrives; the offline queue retries with the same key.
    await batch(m.id, 90, 5);
    const retry = await sell(cashier.auth, body);
    expect(retry.status).toBe(201);
    expect(retry.body.replayed).toBe(false);
  });

  it('replays the sale as it is now, e.g. after it was voided', async () => {
    const { cashier, pharmacist, cart } = await setup();
    const body = cart();
    const first = await sell(cashier.auth, body);
    await voidSale(pharmacist.auth, saleOf(first).id);

    const retry = await sell(cashier.auth, body);

    expect(retry.status).toBe(200);
    expect(retry.body.sale).toMatchObject({ id: first.body.sale.id, status: 'VOIDED' });
    expect(await prisma.sale.count()).toBe(1);
  });
});
