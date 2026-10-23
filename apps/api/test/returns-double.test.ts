// "A sale cannot be returned more than it was sold": sequential and racing
// returns, pending requests holding their units, and rejections freeing them.

import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { authAs, ledgerQuantity, resetDatabase } from './helpers';
import {
  approveReturn,
  createReturn,
  rejectReturn,
  returnOf,
  returnsSetup,
} from './returns-fixtures';

beforeEach(resetDatabase);

describe('double-return prevention', () => {
  it('refuses more than was sold on a line, and changes nothing', async () => {
    const { pharmacist, b2, sale, lineB } = await returnsSetup();

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 8 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Only 7 of 7 can still be returned on this line (8 requested)',
      details: {
        items: [{ saleItemId: lineB.id, requested: 8, sold: 7, returned: 0, returnable: 7 }],
      },
    });
    expect(await ledgerQuantity(b2.id)).toBe(13);
    expect(await prisma.return.count()).toBe(0);
  });

  it('counts earlier returns: a line can be returned in parts but not past what was sold', async () => {
    const { pharmacist, b2, sale, lineB } = await returnsSetup();
    const send = (quantity: number) =>
      createReturn(pharmacist.auth, {
        saleId: sale.id,
        items: [{ saleItemId: lineB.id, quantity }],
      });

    expect((await send(4)).status).toBe(201);
    expect((await send(2)).status).toBe(201);
    const over = await send(2);

    expect(over.status).toBe(409);
    expect(over.body.error.details.items[0]).toMatchObject({ returned: 6, returnable: 1 });
    expect(await ledgerQuantity(b2.id)).toBe(19);

    expect((await send(1)).status).toBe(201);
    expect(await ledgerQuantity(b2.id)).toBe(20);
  });

  it('refuses the whole return when any one line is over, keeping the others untouched', async () => {
    const { pharmacist, b1, b2, sale, lineA, lineB } = await returnsSetup();

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [
        { saleItemId: lineA.id, quantity: 1 },
        { saleItemId: lineB.id, quantity: 9 },
      ],
    });

    expect(res.status).toBe(409);
    expect(await ledgerQuantity(b1.id)).toBe(0);
    expect(await ledgerQuantity(b2.id)).toBe(13);
  });

  it('refuses anything further once the sale has been returned in full', async () => {
    const { pharmacist, b2, sale, lineA, lineB } = await returnsSetup();
    await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [
        { saleItemId: lineA.id, quantity: 3 },
        { saleItemId: lineB.id, quantity: 7 },
      ],
    });

    const again = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1 }],
    });

    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(
      `Sale ${sale.receiptNumber} has already been returned in full`,
    );
    expect(await ledgerQuantity(b2.id)).toBe(20);
  });

  it('counts damaged returns too: units refunded once cannot be refunded again', async () => {
    const { pharmacist, sale, lineB } = await returnsSetup();
    await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 7, restock: false }],
    });

    const again = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1 }],
    });

    expect(again.status).toBe(409);
  });

  it('holds the units of a pending request, and frees them when it is rejected', async () => {
    const { pharmacist, cashier, b2, sale, lineB } = await returnsSetup();
    const pending = await createReturn(cashier.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 5 }],
    });
    expect(returnOf(pending).status).toBe('PENDING');

    const blocked = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 3 }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.items[0]).toMatchObject({ pending: 5, returnable: 2 });

    await rejectReturn(pharmacist.auth, returnOf(pending).id);

    const freed = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 7 }],
    });
    expect(freed.status).toBe(201);
    expect(returnOf(freed).refundTotal).toBe('175.00');
    expect(await ledgerQuantity(b2.id)).toBe(20);
  });

  it('two racing returns for the same units: one succeeds, stock comes back once', async () => {
    const { pharmacist, b2, sale, lineB } = await returnsSetup();
    const admin = await authAs('ADMIN');
    const body = { saleId: sale.id, items: [{ saleItemId: lineB.id, quantity: 7 }] };

    const responses = await Promise.all([
      createReturn(pharmacist.auth, body),
      createReturn(admin.auth, body),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ledgerQuantity(b2.id)).toBe(20);
    expect(await prisma.stockMovement.count({ where: { type: 'RETURN' } })).toBe(1);
    expect(await prisma.return.count()).toBe(1);
  });

  it('two racing approvals of one request: stock and refund happen once', async () => {
    const { pharmacist, cashier, b2, sale, lineB } = await returnsSetup();
    const admin = await authAs('ADMIN');
    const pending = await createReturn(cashier.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 7 }],
    });
    const id = returnOf(pending).id;

    const responses = await Promise.all([
      approveReturn(pharmacist.auth, id),
      approveReturn(admin.auth, id),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ledgerQuantity(b2.id)).toBe(20);
    expect(await prisma.stockMovement.count({ where: { type: 'RETURN' } })).toBe(1);
  });

  it('keeps return numbers gap-free: a refused return does not use one up', async () => {
    const { pharmacist, sale, lineB } = await returnsSetup();
    const send = (quantity: number) =>
      createReturn(pharmacist.auth, {
        saleId: sale.id,
        items: [{ saleItemId: lineB.id, quantity }],
      });

    const first = await send(1);
    expect((await send(99)).status).toBe(409);
    const second = await send(1);

    const seq = (res: typeof first) => returnOf(res).returnNumber.slice(-4);
    expect([seq(first), seq(second)]).toEqual(['0001', '0002']);
  });
});
