import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday, fromDateOnly } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { auditEntries, daysFromToday, ledgerQuantity, resetDatabase } from './helpers';
import { createReturn, returnOf, returnsSetup } from './returns-fixtures';
import { card, cash, getSale, sell, voidSale } from './sales-fixtures';

beforeEach(resetDatabase);

const returnNo = (n: number) =>
  `R-${businessToday().replace(/-/g, '')}-${String(n).padStart(4, '0')}`;

describe('POST /api/returns by a pharmacist (completes at once)', () => {
  it('takes a partial return back into the original batch and refunds it', async () => {
    const { pharmacist, b1, b2, sale, lineB } = await returnsSetup();

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2 }],
      reason: 'Doctor changed prescription',
    });

    expect(res.status).toBe(201);
    expect(returnOf(res)).toMatchObject({
      returnNumber: returnNo(1),
      status: 'COMPLETED',
      sale: { id: sale.id, receiptNumber: sale.receiptNumber },
      requestedBy: { id: pharmacist.user.id },
      reviewedBy: { id: pharmacist.user.id },
      reason: 'Doctor changed prescription',
      refundTotal: '50.00',
      itemCount: 2,
      items: [
        {
          saleItemId: lineB.id,
          batch: { id: b2.id, batchNumber: 'B' },
          quantity: 2,
          restock: true,
          refundAmount: '50.00',
        },
      ],
      refunds: [{ method: 'CASH', amount: '50.00' }],
    });
    expect(await ledgerQuantity(b2.id)).toBe(15);
    expect(await ledgerQuantity(b1.id)).toBe(0);

    const [movement] = await prisma.stockMovement.findMany({ where: { type: 'RETURN' } });
    expect(movement).toMatchObject({
      batchId: b2.id,
      quantity: 2,
      userId: pharmacist.user.id,
      returnItemId: returnOf(res).items[0]!.id,
      reason: `Return ${returnNo(1)}: Doctor changed prescription`,
    });
    // A partial return leaves the sale completed.
    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('COMPLETED');
  });

  it('marks the sale REFUNDED once every unit has come back, over several returns', async () => {
    const { pharmacist, b1, b2, sale, lineA, lineB } = await returnsSetup();

    const first = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [
        { saleItemId: lineA.id, quantity: 3 },
        { saleItemId: lineB.id, quantity: 4 },
      ],
    });
    expect(first.status).toBe(201);
    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('COMPLETED');

    const second = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 3 }],
    });

    expect(second.status).toBe(201);
    expect(returnOf(second).returnNumber).toBe(returnNo(2));
    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('REFUNDED');
    expect(await ledgerQuantity(b1.id)).toBe(3);
    expect(await ledgerQuantity(b2.id)).toBe(20);
    expect(returnOf(first).refundTotal).toBe('175.00');
    expect(returnOf(second).refundTotal).toBe('75.00');
  });

  it('refunds damaged items without putting them back into stock', async () => {
    const { pharmacist, b2, sale, lineB } = await returnsSetup();

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2, restock: false }],
      reason: 'Bottle cracked',
    });

    expect(res.status).toBe(201);
    expect(returnOf(res)).toMatchObject({
      refundTotal: '50.00',
      items: [{ quantity: 2, restock: false }],
    });
    expect(await ledgerQuantity(b2.id)).toBe(13);
    expect(await prisma.stockMovement.count({ where: { type: 'RETURN' } })).toBe(0);
  });

  it('never restocks into a batch that has expired since the sale', async () => {
    const { pharmacist, b1, b2, sale, lineA, lineB } = await returnsSetup();
    await prisma.batch.update({
      where: { id: b1.id },
      data: { expiryDate: fromDateOnly(daysFromToday(-1)) },
    });

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [
        { saleItemId: lineA.id, quantity: 1 },
        { saleItemId: lineB.id, quantity: 1 },
      ],
    });

    expect(res.status).toBe(201);
    expect(returnOf(res).items.map((i) => [i.saleItemId, i.restock])).toEqual([
      [lineA.id, false],
      [lineB.id, true],
    ]);
    expect(returnOf(res).refundTotal).toBe('50.00');
    expect(await ledgerQuantity(b1.id)).toBe(0);
    expect(await ledgerQuantity(b2.id)).toBe(14);

    const [entry] = await auditEntries('RETURN_CREATE');
    expect(entry!.after).toMatchObject({
      restocked: [{ batchId: b2.id, quantity: 1 }],
      notRestockedExpired: [{ batchId: b1.id, quantity: 1 }],
    });
  });

  it('refunds exactly what was paid, discount shares included, however the line is split', async () => {
    // 10 × 9.99 = 99.90 less a 10% bill discount = 89.91. The discount splits
    // 3.00 / 6.99 over the lines, so line A is 26.97 and line B is 62.94.
    const { pharmacist, sale, lineA, lineB } = await returnsSetup({
      sellingPrice: '9.99',
      discount: { type: 'PERCENT', value: '10' },
      payments: [cash('100')],
    });
    expect(sale.grandTotal).toBe('89.91');
    expect([lineA.lineTotal, lineB.lineTotal]).toEqual(['26.97', '62.94']);

    const refunds: string[] = [];
    for (const [line, quantity] of [
      [lineB, 3],
      [lineB, 3],
      [lineB, 1],
      [lineA, 3],
    ] as const) {
      const res = await createReturn(pharmacist.auth, {
        saleId: sale.id,
        items: [{ saleItemId: line.id, quantity }],
      });
      expect(res.status).toBe(201);
      refunds.push(returnOf(res).refundTotal);
    }

    // Pro rata rounded down; the last units of a line take what is left.
    expect(refunds).toEqual(['26.97', '26.97', '9.00', '26.97']);
    const totals = await prisma.return.aggregate({ _sum: { refundTotal: true } });
    expect(totals._sum.refundTotal!.toFixed(2)).toBe('89.91');
    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('REFUNDED');
  });

  it('records RETURN_CREATE in the audit log', async () => {
    const { pharmacist, b2, sale, lineB } = await returnsSetup();
    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2 }],
      reason: 'Wrong strength',
    });

    const [entry] = await auditEntries('RETURN_CREATE');
    expect(entry).toMatchObject({
      userId: pharmacist.user.id,
      entityType: 'Return',
      entityId: returnOf(res).id,
      after: {
        returnNumber: returnNo(1),
        receiptNumber: sale.receiptNumber,
        status: 'COMPLETED',
        reason: 'Wrong strength',
        refundTotal: '50.00',
        items: [{ saleItemId: lineB.id, batchId: b2.id, quantity: 2, restockRequested: true }],
        refunds: [{ method: 'CASH', amount: '50.00' }],
        restocked: [{ batchId: b2.id, quantity: 2 }],
        saleStatus: 'COMPLETED',
      },
    });
  });
});

describe('refunds by payment method', () => {
  /** 250.00 paid 150 by card and 100 in cash. */
  const splitPaid = () => returnsSetup({ payments: [card('150'), cash('100')] });

  it('refunds cash first, then card, when no split is given', async () => {
    const { pharmacist, sale, lineB } = await splitPaid();

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 7 }],
    });

    expect(res.status).toBe(201);
    expect(returnOf(res).refunds).toMatchObject([
      { method: 'CASH', amount: '100.00' },
      { method: 'CARD', amount: '75.00' },
    ]);
  });

  it('accepts a split by the methods the sale was paid with', async () => {
    const { pharmacist, sale, lineB } = await splitPaid();

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 7 }],
      refunds: [
        { method: 'CARD', amount: '150', reference: 'RF-778' },
        { method: 'CASH', amount: '25' },
      ],
    });

    expect(res.status).toBe(201);
    expect(returnOf(res).refunds).toMatchObject([
      { method: 'CASH', amount: '25.00', reference: null },
      { method: 'CARD', amount: '150.00', reference: 'RF-778' },
    ]);
  });

  it('refuses a method the sale was not paid with', async () => {
    const { pharmacist, sale, lineB } = await splitPaid();
    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1 }],
      refunds: [{ method: 'MOBILE_WALLET', amount: '25' }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toMatch(/Nothing can be refunded by mobile wallet/);
  });

  it('refuses more by a method than was paid that way', async () => {
    const { pharmacist, sale, lineB } = await splitPaid();
    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 7 }],
      refunds: [{ method: 'CARD', amount: '175' }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toMatch(/At most 150\.00 can be refunded by card/);
  });

  it('counts earlier refunds against what a method can still refund', async () => {
    const { pharmacist, sale, lineA, lineB } = await splitPaid();
    // 4 units = 100.00, all of it cash.
    await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 4 }],
    });

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineA.id, quantity: 1 }],
      refunds: [{ method: 'CASH', amount: '25' }],
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error)).toMatch(/Nothing can be refunded by cash/);
  });

  it('refuses a split that does not add up to the refund due', async () => {
    const { pharmacist, b2, sale, lineB } = await splitPaid();
    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2 }],
      refunds: [{ method: 'CARD', amount: '40' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Refunds add up to 40.00 but the refund due is 50.00');
    expect(await ledgerQuantity(b2.id)).toBe(13);
    expect(await prisma.return.count()).toBe(0);
  });
});

describe('POST /api/returns validation', () => {
  it('requires a reason', async () => {
    const { pharmacist, sale, lineB } = await returnsSetup();
    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1 }],
      reason: '  ',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects no items, zero quantities and the same line twice', async () => {
    const { pharmacist, sale, lineB } = await returnsSetup();
    const send = (items: { saleItemId: string; quantity: number }[]) =>
      createReturn(pharmacist.auth, { saleId: sale.id, items });

    expect((await send([])).status).toBe(400);
    expect((await send([{ saleItemId: lineB.id, quantity: 0 }])).status).toBe(400);
    const twice = await send([
      { saleItemId: lineB.id, quantity: 1 },
      { saleItemId: lineB.id, quantity: 1 },
    ]);
    expect(twice.status).toBe(400);
    expect(JSON.stringify(twice.body)).toMatch(/appears twice/);
  });

  it('refuses a refund amount sent as a number, or a client-chosen refund amount per item', async () => {
    const { pharmacist, sale, lineB } = await returnsSetup();
    const numeric = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1 }],
      refunds: [{ method: 'CASH', amount: 25 }],
    });
    expect(numeric.status).toBe(400);
    const priced = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1, refundAmount: '999' } as never],
    });
    expect(priced.status).toBe(400);
  });

  it('rejects a line from a different sale', async () => {
    const { pharmacist, cashier, m, sale } = await returnsSetup();
    const other = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('25')],
    });

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: other.body.sale.items[0].id, quantity: 1 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.items[0]).toMatchObject({ message: 'Not a line of this sale' });
  });

  it('returns 404 for an unknown sale', async () => {
    const { pharmacist, lineB } = await returnsSetup();
    const res = await createReturn(pharmacist.auth, {
      saleId: '00000000-0000-4000-8000-000000000000',
      items: [{ saleItemId: lineB.id, quantity: 1 }],
    });
    expect(res.status).toBe(404);
  });

  it('refuses a return against a voided sale', async () => {
    const { pharmacist, b2, sale, lineB } = await returnsSetup();
    await voidSale(pharmacist.auth, sale.id);

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 1 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/is voided/);
    expect(await ledgerQuantity(b2.id)).toBe(20);
  });
});
