import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { authAs, ledgerQuantity, resetDatabase } from './helpers';
import { cash, receiptNo, salesSetup, sell } from './sales-fixtures';

// These tests fire requests in parallel so their transactions really overlap.
// They rely on the batch row locks (lib/stock.ts) and the receipt counter lock
// in the sales service; without them they oversell or duplicate receipts.

beforeEach(resetDatabase);

const statuses = (responses: { status: number }[]) => responses.map((r) => r.status).sort();

describe('concurrent sales', () => {
  it('two sales racing for the last unit: exactly one wins', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const other = await authAs('CASHIER', 'cashier2');
    const m = await medicine('Insulin pen');

    // Several rounds, each with a fresh last unit, to make an interleaving
    // that would oversell very likely to show up if the locking were wrong.
    for (let round = 1; round <= 5; round++) {
      const b = await batch(m.id, 30 + round, 1, `LAST-${round}`);
      const cart = { items: [{ medicineId: m.id, quantity: 1 }], payments: [cash('10')] };

      const responses = await Promise.all([sell(cashier.auth, cart), sell(other.auth, cart)]);

      expect(statuses(responses)).toEqual([201, 409]);
      const loser = responses.find((r) => r.status === 409)!;
      expect(loser.body.error).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        details: { items: [{ requested: 1, available: 0 }] },
      });
      expect(await ledgerQuantity(b.id)).toBe(0);
    }
    expect(await prisma.sale.count()).toBe(5);
  });

  it('never oversells when many sales race for a few units', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    const b1 = await batch(m.id, 30, 2);
    const b2 = await batch(m.id, 60, 1);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        sell(cashier.auth, {
          items: [{ medicineId: m.id, quantity: 1 }],
          payments: [cash('10')],
        }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await ledgerQuantity(b1.id)).toBe(0);
    expect(await ledgerQuantity(b2.id)).toBe(0);
    expect(await prisma.saleItem.aggregate({ _sum: { quantity: true } })).toMatchObject({
      _sum: { quantity: 3 },
    });
  });

  it('gives concurrent sales unique, gap-free receipt numbers', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    await batch(m.id, 30, 100);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        sell(cashier.auth, {
          items: [{ medicineId: m.id, quantity: 1 }],
          payments: [cash('10')],
        }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    const numbers = responses.map((r) => r.body.sale.receiptNumber as string).sort();
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => receiptNo(i + 1)));
  });

  it('does not deadlock when carts list the same medicines in opposite orders', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const a = await medicine('Panadol 500mg');
    const b = await medicine('Flagyl 400mg');
    const aBatch = await batch(a.id, 30, 100);
    const bBatch = await batch(b.id, 30, 100);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const items = [
          { medicineId: a.id, quantity: 1 },
          { medicineId: b.id, quantity: 1 },
        ];
        return sell(cashier.auth, {
          items: i % 2 === 0 ? items : items.reverse(),
          payments: [cash('20')],
        });
      }),
    );

    expect(statuses(responses)).toEqual(Array(10).fill(201));
    expect(await ledgerQuantity(aBatch.id)).toBe(90);
    expect(await ledgerQuantity(bBatch.id)).toBe(90);
  });
});
