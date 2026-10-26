import { beforeEach, describe, expect, it } from 'vitest';
import { fromDateOnly } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { auditEntries, authAs, daysFromToday, ledgerQuantity, resetDatabase } from './helpers';
import {
  approveReturn,
  createReturn,
  getReturn,
  listReturns,
  rejectReturn,
  returnOf,
  returnable,
  returnableOf,
  returnsSetup,
} from './returns-fixtures';
import { card, cash, getSale } from './sales-fixtures';

beforeEach(resetDatabase);

/** The standard sale (rung up by the pharmacist) and a cashier's request for 2 of line B. */
async function cashierRequest() {
  const ctx = await returnsSetup();
  const res = await createReturn(ctx.cashier.auth, {
    saleId: ctx.sale.id,
    items: [{ saleItemId: ctx.lineB.id, quantity: 2 }],
    reason: 'Customer bought the wrong pack size',
  });
  expect(res.status).toBe(201);
  return { ...ctx, pending: returnOf(res) };
}

describe('cashier requests', () => {
  it('are saved as PENDING without touching stock, even for someone else’s sale', async () => {
    const { cashier, pharmacist, b2, sale, pending } = await cashierRequest();

    expect(pending).toMatchObject({
      status: 'PENDING',
      requestedBy: { id: cashier.user.id },
      reviewedBy: null,
      reviewedAt: null,
      refundTotal: '50.00',
      refunds: [{ method: 'CASH', amount: '50.00' }],
    });
    expect(await ledgerQuantity(b2.id)).toBe(13);
    expect(await prisma.stockMovement.count({ where: { type: 'RETURN' } })).toBe(0);
    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('COMPLETED');

    const [entry] = await auditEntries('RETURN_CREATE');
    expect(entry).toMatchObject({
      userId: cashier.user.id,
      entityId: pending.id,
      after: { status: 'PENDING', reason: 'Customer bought the wrong pack size' },
    });
    expect(entry!.after).not.toHaveProperty('restocked');
  });

  it('cannot be approved or rejected by a cashier, even their own', async () => {
    const { cashier, b2, pending } = await cashierRequest();

    expect((await approveReturn(cashier.auth, pending.id)).status).toBe(403);
    expect((await rejectReturn(cashier.auth, pending.id)).status).toBe(403);
    expect(await ledgerQuantity(b2.id)).toBe(13);
  });
});

describe('POST /api/returns/:id/approve', () => {
  it('completes the return: restocks the original batch and records the approver', async () => {
    const { pharmacist, cashier, b2, pending } = await cashierRequest();

    const res = await approveReturn(pharmacist.auth, pending.id);

    expect(res.status).toBe(200);
    expect(returnOf(res)).toMatchObject({
      status: 'COMPLETED',
      requestedBy: { id: cashier.user.id },
      reviewedBy: { id: pharmacist.user.id },
      items: [{ quantity: 2, restock: true }],
    });
    expect(returnOf(res).reviewedAt).toBeTruthy();
    expect(await ledgerQuantity(b2.id)).toBe(15);
    const [movement] = await prisma.stockMovement.findMany({ where: { type: 'RETURN' } });
    expect(movement).toMatchObject({ batchId: b2.id, quantity: 2, userId: pharmacist.user.id });

    const [entry] = await auditEntries('RETURN_APPROVE');
    expect(entry).toMatchObject({
      userId: pharmacist.user.id,
      entityId: pending.id,
      before: { status: 'PENDING' },
      after: { status: 'COMPLETED', restocked: [{ batchId: b2.id, quantity: 2 }] },
    });
  });

  it('lets an admin approve too', async () => {
    const { pending } = await cashierRequest();
    const admin = await authAs('ADMIN');
    expect((await approveReturn(admin.auth, pending.id)).status).toBe(200);
  });

  it('marks the sale REFUNDED when the approved request brings the last units back', async () => {
    const { pharmacist, cashier, sale, lineA, lineB } = await returnsSetup();
    const res = await createReturn(cashier.auth, {
      saleId: sale.id,
      items: [
        { saleItemId: lineA.id, quantity: 3 },
        { saleItemId: lineB.id, quantity: 7 },
      ],
    });
    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('COMPLETED');

    await approveReturn(pharmacist.auth, returnOf(res).id);

    expect((await getSale(pharmacist.auth, sale.id)).body.sale.status).toBe('REFUNDED');
  });

  it('keeps units out of stock if their batch expired while the request waited', async () => {
    const { pharmacist, b2, pending } = await cashierRequest();
    await prisma.batch.update({
      where: { id: b2.id },
      data: { expiryDate: fromDateOnly(daysFromToday(0)) },
    });

    const res = await approveReturn(pharmacist.auth, pending.id);

    expect(res.status).toBe(200);
    expect(returnOf(res).items[0]!.restock).toBe(false);
    expect(returnOf(res).refundTotal).toBe('50.00');
    expect(await ledgerQuantity(b2.id)).toBe(13);
  });

  it('refuses to approve twice', async () => {
    const { pharmacist, b2, pending } = await cashierRequest();
    await approveReturn(pharmacist.auth, pending.id);

    const again = await approveReturn(pharmacist.auth, pending.id);

    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(`Return ${pending.returnNumber} is already completed`);
    expect(await ledgerQuantity(b2.id)).toBe(15);
  });

  it('returns 404 for an unknown return', async () => {
    const { pharmacist } = await returnsSetup();
    const res = await approveReturn(pharmacist.auth, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/returns/:id/reject', () => {
  it('rejects with a reason and changes no stock', async () => {
    const { pharmacist, b2, pending } = await cashierRequest();

    const res = await rejectReturn(pharmacist.auth, pending.id, 'Seal broken, cannot resell');

    expect(res.status).toBe(200);
    expect(returnOf(res)).toMatchObject({
      status: 'REJECTED',
      reviewedBy: { id: pharmacist.user.id },
      rejectionReason: 'Seal broken, cannot resell',
    });
    expect(await ledgerQuantity(b2.id)).toBe(13);
    const [entry] = await auditEntries('RETURN_REJECT');
    expect(entry).toMatchObject({
      userId: pharmacist.user.id,
      before: { status: 'PENDING' },
      after: { status: 'REJECTED', reason: 'Seal broken, cannot resell' },
    });
  });

  it('requires a reason', async () => {
    const { pharmacist, pending } = await cashierRequest();
    const res = await rejectReturn(pharmacist.auth, pending.id, '');
    expect(res.status).toBe(400);
  });

  it('cannot be approved afterwards', async () => {
    const { pharmacist, b2, pending } = await cashierRequest();
    await rejectReturn(pharmacist.auth, pending.id);

    const res = await approveReturn(pharmacist.auth, pending.id);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already rejected/);
    expect(await ledgerQuantity(b2.id)).toBe(13);
  });

  it('frees the request’s refund capacity as well as its units', async () => {
    const { pharmacist, cashier, sale, lineB } = await returnsSetup({
      payments: [card('200'), cash('50')],
    });
    const pending = await createReturn(cashier.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2 }],
    });
    expect(returnOf(pending).refunds).toMatchObject([{ method: 'CASH', amount: '50.00' }]);
    await rejectReturn(pharmacist.auth, returnOf(pending).id);

    const res = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2 }],
      refunds: [{ method: 'CASH', amount: '50' }],
    });
    expect(res.status).toBe(201);
  });
});

describe('reading returns', () => {
  it('shows a cashier only the returns they requested', async () => {
    const { pharmacist, cashier, sale, lineA, pending } = await cashierRequest();
    const other = await authAs('CASHIER', 'cashier2');
    const own = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineA.id, quantity: 1 }],
    });

    expect((await getReturn(cashier.auth, pending.id)).status).toBe(200);
    expect((await getReturn(other.auth, pending.id)).status).toBe(404);
    expect((await getReturn(cashier.auth, returnOf(own).id)).status).toBe(404);

    const list = await listReturns(cashier.auth, { requestedById: pharmacist.user.id });
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([pending.id]);
  });

  it('lets managers list everything and filter the approval queue', async () => {
    const { pharmacist, sale, lineA, pending } = await cashierRequest();
    const done = await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineA.id, quantity: 1 }],
    });

    const all = await listReturns(pharmacist.auth);
    expect(all.body.total).toBe(2);

    const queue = await listReturns(pharmacist.auth, { status: 'PENDING' });
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        id: pending.id,
        status: 'PENDING',
        sale: expect.objectContaining({ receiptNumber: sale.receiptNumber }),
        refundTotal: '50.00',
        itemCount: 2,
      }),
    ]);

    const bySale = await listReturns(pharmacist.auth, {
      saleId: sale.id,
      q: returnOf(done).returnNumber,
    });
    expect(bySale.body.items.map((r: { id: string }) => r.id)).toEqual([returnOf(done).id]);
  });
});

describe('GET /api/returns/returnable', () => {
  it('shows each line’s returned, pending and returnable units and refundable amounts', async () => {
    const { pharmacist, cashier, sale, lineA, lineB } = await returnsSetup({
      payments: [card('100'), cash('150')],
    });
    await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineA.id, quantity: 1 }],
    });
    await createReturn(cashier.auth, {
      saleId: sale.id,
      items: [{ saleItemId: lineB.id, quantity: 2 }],
    });

    // Any cashier can look up any sale by the receipt number on the slip.
    const res = await returnable(cashier.auth, { receiptNumber: sale.receiptNumber.toLowerCase() });

    expect(res.status).toBe(200);
    const body = returnableOf(res);
    expect(body.sale).toMatchObject({ id: sale.id, status: 'COMPLETED', grandTotal: '250.00' });
    expect(
      body.lines.map((l) => [l.id, l.returnedQuantity, l.pendingQuantity, l.returnableQuantity]),
    ).toEqual([
      [lineA.id, 1, 0, 2],
      [lineB.id, 0, 2, 5],
    ]);
    // 75.00 paid for line A less 25.00 refunded; 175.00 for line B less 50.00 pending.
    expect(body.lines.map((l) => l.refundableAmount)).toEqual(['50.00', '125.00']);
    expect(body.refundable).toEqual([
      { method: 'CASH', paid: '150.00', available: '75.00' },
      { method: 'CARD', paid: '100.00', available: '100.00' },
    ]);
    expect(body.canReturn).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/costPrice/);
  });

  it('says nothing can be returned once everything is back', async () => {
    const { pharmacist, sale, lineA, lineB } = await returnsSetup();
    await createReturn(pharmacist.auth, {
      saleId: sale.id,
      items: [
        { saleItemId: lineA.id, quantity: 3 },
        { saleItemId: lineB.id, quantity: 7 },
      ],
    });

    const body = returnableOf(await returnable(pharmacist.auth, { saleId: sale.id }));

    expect(body.sale.status).toBe('REFUNDED');
    expect(body.canReturn).toBe(false);
    expect(body.refundable).toEqual([{ method: 'CASH', paid: '250.00', available: '0.00' }]);
  });

  it('needs exactly one of saleId or receiptNumber, and 404s an unknown sale', async () => {
    const { pharmacist, sale } = await returnsSetup();
    expect((await returnable(pharmacist.auth, {})).status).toBe(400);
    expect(
      (await returnable(pharmacist.auth, { saleId: sale.id, receiptNumber: sale.receiptNumber }))
        .status,
    ).toBe(400);
    expect((await returnable(pharmacist.auth, { receiptNumber: 'S-19990101-0001' })).status).toBe(
      404,
    );
  });
});
