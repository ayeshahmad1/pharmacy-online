import { ROLE_CODES } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, auditEntries, authAs, ledgerQuantity, resetDatabase } from './helpers';
import { card, cash, receiptNo, saleOf, salesSetup, sell, wallet } from './sales-fixtures';

beforeEach(resetDatabase);

/** Nothing from a rejected sale may be left behind (CLAUDE.md rule 4). */
async function expectNothingSaved() {
  expect(await prisma.sale.count()).toBe(0);
  expect(await prisma.saleItem.count()).toBe(0);
  expect(await prisma.payment.count()).toBe(0);
  expect(await prisma.stockMovement.count({ where: { type: 'SALE' } })).toBe(0);
  expect(await prisma.receiptCounter.count()).toBe(0);
  expect(await auditEntries('SALE_CREATE')).toHaveLength(0);
}

describe('FEFO batch allocation', () => {
  it('sells from the batch with the earliest expiry first', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    // Created out of order so FEFO can't be an accident of insertion order.
    const late = await batch(m.id, 300, 50, 'LATE');
    const early = await batch(m.id, 30, 50, 'EARLY');
    const mid = await batch(m.id, 100, 50, 'MID');

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 5 }],
      payments: [cash('50')],
    });

    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.sale.items).toHaveLength(1);
    expect(res.body.sale.items[0]).toMatchObject({
      medicine: { id: m.id, name: 'Panadol 500mg' },
      batch: { id: early.id, batchNumber: 'EARLY' },
      quantity: 5,
      unitPrice: '10.00',
      lineTotal: '50.00',
    });
    expect(await ledgerQuantity(early.id)).toBe(45);
    expect(await ledgerQuantity(mid.id)).toBe(50);
    expect(await ledgerQuantity(late.id)).toBe(50);
  });

  it('spans several batches in expiry order, one sale line and one movement per batch', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Augmentin 625mg', '25.00');
    const late = await batch(m.id, 400, 50, 'C');
    const early = await batch(m.id, 20, 3, 'A');
    const mid = await batch(m.id, 60, 4, 'B');

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 10 }],
      payments: [cash('250')],
    });

    expect(res.status).toBe(201);
    const sale = saleOf(res);
    expect(sale.items.map((i) => [i.batch.id, i.quantity, i.lineTotal])).toEqual([
      [early.id, 3, '75.00'],
      [mid.id, 4, '100.00'],
      [late.id, 3, '75.00'],
    ]);
    expect(sale.grandTotal).toBe('250.00');
    expect(await ledgerQuantity(early.id)).toBe(0);
    expect(await ledgerQuantity(mid.id)).toBe(0);
    expect(await ledgerQuantity(late.id)).toBe(47);

    const movements = await prisma.stockMovement.findMany({
      where: { type: 'SALE' },
      include: { saleItem: true },
    });
    expect(movements).toHaveLength(3);
    for (const mv of movements) {
      expect(mv.saleItem!.saleId).toBe(sale.id);
      expect(mv.quantity).toBe(-mv.saleItem!.quantity);
      expect(mv.batchId).toBe(mv.saleItem!.batchId);
      expect(mv.reason).toBe(`Sale ${sale.receiptNumber}`);
    }
  });

  it('skips batches that are already empty', async () => {
    const { cashier, pharmacist, medicine, batch } = await salesSetup();
    const m = await medicine('Brufen 400mg');
    const emptied = await batch(m.id, 10, 5, 'EMPTY');
    await prisma.stockMovement.create({
      data: {
        batchId: emptied.id,
        type: 'ADJUSTMENT',
        quantity: -5,
        reason: 'Damaged',
        userId: pharmacist.user.id,
      },
    });
    const next = await batch(m.id, 50, 5, 'NEXT');

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2 }],
      payments: [cash('20')],
    });

    expect(res.status).toBe(201);
    expect(saleOf(res).items.map((i) => i.batch.id)).toEqual([next.id]);
  });

  it('allocates each medicine of a multi-item cart independently', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const a = await medicine('Panadol 500mg', '2.50');
    const b = await medicine('Flagyl 400mg', '6.00');
    const a1 = await batch(a.id, 30, 2);
    const a2 = await batch(a.id, 90, 10);
    const b1 = await batch(b.id, 45, 10);

    const res = await sell(cashier.auth, {
      items: [
        { medicineId: a.id, quantity: 4 },
        { medicineId: b.id, quantity: 3 },
      ],
      payments: [cash('28')],
    });

    expect(res.status).toBe(201);
    // Receipt order: cart order, then FEFO within each medicine.
    expect(saleOf(res).items.map((i) => [i.batch.id, i.quantity])).toEqual([
      [a1.id, 2],
      [a2.id, 2],
      [b1.id, 3],
    ]);
    expect(res.body.sale.subtotal).toBe('28.00');
  });
});

describe('expired stock is never sold', () => {
  it('excludes expired batches even when they expire first', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Amoxil 250mg');
    const expired = await batch(m.id, -10, 100, 'EXPIRED');
    const good = await batch(m.id, 60, 5, 'GOOD');

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 5 }],
      payments: [cash('50')],
    });

    expect(res.status).toBe(201);
    expect(saleOf(res).items.map((i) => i.batch.id)).toEqual([good.id]);
    expect(await ledgerQuantity(expired.id)).toBe(100);
  });

  it('treats a batch expiring today as expired', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Amoxil 250mg');
    const today = await batch(m.id, 0, 100, 'TODAY');
    const tomorrow = await batch(m.id, 1, 1, 'TOMORROW');

    const ok = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.sale.items[0].batch.id).toBe(tomorrow.id);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await ledgerQuantity(today.id)).toBe(100);
  });

  it('rejects a sale when only expired stock is left, and says so', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Septran DS');
    await batch(m.id, -1, 20);
    await batch(m.id, 30, 2);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 5 }],
      payments: [cash('50')],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.details.items).toEqual([
      {
        index: 0,
        medicineId: m.id,
        name: 'Septran DS',
        unit: 'tablet',
        requested: 5,
        available: 2,
        expiredQuantity: 20,
      },
    ]);
    await expectNothingSaved();
  });
});

describe('insufficient stock', () => {
  it('rejects a sale larger than sellable stock across all batches, saving nothing', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    const b1 = await batch(m.id, 30, 3);
    const b2 = await batch(m.id, 60, 4);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 8 }],
      payments: [cash('80')],
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      message: 'Not enough stock of Panadol 500mg: 8 tablet requested, 7 available',
      details: { items: [{ medicineId: m.id, requested: 8, available: 7, expiredQuantity: 0 }] },
    });
    expect(await ledgerQuantity(b1.id)).toBe(3);
    expect(await ledgerQuantity(b2.id)).toBe(4);
    await expectNothingSaved();
  });

  it('can sell exactly all remaining stock', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    const b1 = await batch(m.id, 30, 3);
    const b2 = await batch(m.id, 60, 4);
    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 7 }],
      payments: [cash('70')],
    });
    expect(res.status).toBe(201);
    expect(await ledgerQuantity(b1.id)).toBe(0);
    expect(await ledgerQuantity(b2.id)).toBe(0);
  });

  it('rejects the whole cart when any one line is short', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const a = await medicine('Panadol 500mg');
    const b = await medicine('Flagyl 400mg');
    const c = await medicine('Brufen 400mg');
    const aBatch = await batch(a.id, 30, 100);
    await batch(b.id, 30, 1);
    // c has no batches at all.

    const res = await sell(cashier.auth, {
      items: [
        { medicineId: a.id, quantity: 5 },
        { medicineId: b.id, quantity: 2 },
        { medicineId: c.id, quantity: 1 },
      ],
      payments: [cash('80')],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Not enough stock for some items');
    expect(res.body.error.details.items).toMatchObject([
      { index: 1, medicineId: b.id, requested: 2, available: 1 },
      { index: 2, medicineId: c.id, requested: 1, available: 0 },
    ]);
    expect(await ledgerQuantity(aBatch.id)).toBe(100);
    await expectNothingSaved();
  });
});

describe('pricing and discounts', () => {
  it('prices from the catalogue and refuses a client-supplied price', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '12.75');
    await batch(m.id, 30, 10);

    const cheat = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2, unitPrice: '0.01' }],
      payments: [cash('0.02')],
    });
    expect(cheat.status).toBe(400);
    expect(cheat.body.error.code).toBe('VALIDATION_ERROR');

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2 }],
      payments: [cash('25.50')],
    });
    expect(res.status).toBe(201);
    expect(res.body.sale).toMatchObject({
      subtotal: '25.50',
      discountTotal: '0.00',
      taxTotal: '0.00',
      grandTotal: '25.50',
    });
  });

  it('applies line and bill discounts and stores each line its share', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const a = await medicine('Nexium 40mg', '100.00');
    const b = await medicine('Panadol 500mg', '10.00');
    await batch(a.id, 30, 10);
    await batch(b.id, 30, 10);

    const res = await sell(pharmacist.auth, {
      items: [
        { medicineId: a.id, quantity: 1, discount: { type: 'AMOUNT', value: '10' } },
        { medicineId: b.id, quantity: 3 },
      ],
      // 10% of (90 + 30) = 12, spread 9 / 3.
      discount: { type: 'PERCENT', value: '10' },
      payments: [cash('108')],
    });

    expect(res.status).toBe(201);
    const sale = saleOf(res);
    expect(sale).toMatchObject({
      subtotal: '130.00',
      discountTotal: '22.00',
      grandTotal: '108.00',
    });
    expect(sale.items.map((i) => [i.discount, i.lineTotal])).toEqual([
      ['19.00', '81.00'],
      ['3.00', '27.00'],
    ]);
  });

  it('splits a line discount across the batches it was sold from', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    await batch(m.id, 30, 2);
    await batch(m.id, 60, 10);

    const res = await sell(pharmacist.auth, {
      items: [{ medicineId: m.id, quantity: 3, discount: { type: 'AMOUNT', value: '1' } }],
      payments: [cash('29')],
    });

    expect(res.status).toBe(201);
    expect(saleOf(res).items.map((i) => [i.quantity, i.discount, i.lineTotal])).toEqual([
      [2, '0.67', '19.33'],
      [1, '0.33', '9.67'],
    ]);
    expect(res.body.sale.grandTotal).toBe('29.00');
  });

  it('lets a cashier discount up to 10% of the bill', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '50.00');
    await batch(m.id, 30, 10);
    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2, discount: { type: 'AMOUNT', value: '5' } }],
      discount: { type: 'AMOUNT', value: '5' },
      payments: [cash('90')],
    });
    expect(res.status).toBe(201);
    expect(res.body.sale.discountTotal).toBe('10.00');
  });

  it('rejects a cashier discount above 10%, saving nothing', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '50.00');
    const b = await batch(m.id, 30, 10);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2 }],
      discount: { type: 'AMOUNT', value: '10.01' },
      payments: [cash('89.99')],
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { maxPercent: 10, maxDiscount: '10.00', requested: '10.01' },
    });
    expect(await ledgerQuantity(b.id)).toBe(10);
    await expectNothingSaved();
  });

  it('does not cap pharmacist or admin discounts', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const admin = await authAs('ADMIN');
    const m = await medicine('Panadol 500mg', '50.00');
    await batch(m.id, 30, 10);

    for (const auth of [pharmacist.auth, admin.auth]) {
      const res = await sell(auth, {
        items: [{ medicineId: m.id, quantity: 1 }],
        discount: { type: 'PERCENT', value: '60' },
        payments: [cash('20')],
      });
      expect(res.status).toBe(201);
      expect(res.body.sale.grandTotal).toBe('20.00');
    }
  });

  it('rejects a discount larger than its line', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    await batch(m.id, 30, 10);
    const res = await sell(pharmacist.auth, {
      items: [{ medicineId: m.id, quantity: 1, discount: { type: 'AMOUNT', value: '10.50' } }],
      payments: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.items[0]).toMatchObject({ index: 0, field: 'discount' });
    await expectNothingSaved();
  });

  it('rejects malformed discounts', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    await batch(m.id, 30, 10);
    for (const discount of [
      { type: 'PERCENT', value: '101' },
      { type: 'PERCENT', value: '0' },
      { type: 'AMOUNT', value: '-5' },
      { type: 'AMOUNT', value: 5 },
      { type: 'FREE', value: '1' },
    ]) {
      const res = await sell(pharmacist.auth, {
        items: [{ medicineId: m.id, quantity: 1, discount }],
        payments: [cash('10')],
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('payments and change', () => {
  it('gives change from cash and records what was handed over', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    await batch(m.id, 30, 10);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 3 }],
      payments: [cash('100')],
    });

    expect(res.status).toBe(201);
    expect(res.body.sale).toMatchObject({
      grandTotal: '30.00',
      changeDue: '70.00',
      amountTendered: '100.00',
      payments: [{ method: 'CASH', amount: '30.00', tendered: '100.00', reference: null }],
    });
  });

  it('accepts a split across card, mobile wallet and cash', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Glucophage 500mg', '20.00');
    await batch(m.id, 30, 10);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 5 }],
      payments: [card('50', 'AP-778'), wallet('30', 'EP-123'), cash('50')],
    });

    expect(res.status).toBe(201);
    expect(res.body.sale.changeDue).toBe('30.00');
    expect(res.body.sale.payments).toMatchObject([
      { method: 'CASH', amount: '20.00', tendered: '50.00' },
      { method: 'CARD', amount: '50.00', tendered: null, reference: 'AP-778' },
      { method: 'MOBILE_WALLET', amount: '30.00', tendered: null, reference: 'EP-123' },
    ]);
    const stored = await prisma.payment.aggregate({ _sum: { amount: true } });
    expect(stored._sum.amount!.toFixed(2)).toBe('100.00');
  });

  it('accepts an exact card payment', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    await batch(m.id, 30, 10);
    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [card('10')],
    });
    expect(res.status).toBe(201);
    expect(res.body.sale.changeDue).toBe('0.00');
  });

  it('rejects a short payment, saving nothing', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    const b = await batch(m.id, 30, 10);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 3 }],
      payments: [card('10'), cash('19.99')],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toMatchObject({ due: '30.00', paid: '29.99', short: '0.01' });
    expect(await ledgerQuantity(b.id)).toBe(10);
    await expectNothingSaved();
  });

  it('rejects card payments above the total', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    await batch(m.id, 30, 10);
    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [card('20')],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/exceed the bill total/);
  });

  it('rejects cash split into two entries, and zero or float amounts', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg', '10.00');
    await batch(m.id, 30, 10);
    for (const payments of [
      [cash('5'), cash('5')],
      [cash('0')],
      [{ method: 'CASH', amount: 10 }],
      [{ method: 'CHEQUE', amount: '10' }],
    ]) {
      const res = await sell(cashier.auth, {
        items: [{ medicineId: m.id, quantity: 1 }],
        payments,
      });
      expect(res.status).toBe(400);
    }
    await expectNothingSaved();
  });

  it('needs no payment for a fully discounted bill', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const m = await medicine('Sample pack', '10.00');
    await batch(m.id, 30, 10);
    const res = await sell(pharmacist.auth, {
      items: [{ medicineId: m.id, quantity: 1, discount: { type: 'PERCENT', value: '100' } }],
      payments: [],
    });
    expect(res.status).toBe(201);
    expect(res.body.sale).toMatchObject({ grandTotal: '0.00', payments: [] });
  });
});

describe('receipt numbers', () => {
  it('numbers receipts per business day starting at 0001', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    await batch(m.id, 30, 10);
    const sale = () =>
      sell(cashier.auth, { items: [{ medicineId: m.id, quantity: 1 }], payments: [cash('10')] });

    expect((await sale()).body.sale.receiptNumber).toBe(receiptNo(1));
    expect((await sale()).body.sale.receiptNumber).toBe(receiptNo(2));
    expect((await sale()).body.sale.receiptNumber).toBe(receiptNo(3));
  });

  it('gives the number back when a sale is rejected', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    await batch(m.id, 30, 1);

    const rejected = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2 }],
      payments: [cash('20')],
    });
    expect(rejected.status).toBe(409);

    const ok = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 1 }],
      payments: [cash('10')],
    });
    expect(ok.body.sale.receiptNumber).toBe(receiptNo(1));
  });
});

describe('validation and permissions', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/sales').send({});
    expect(res.status).toBe(401);
  });

  it('lets every role sell', async () => {
    const { medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    await batch(m.id, 30, 10);
    for (const role of ROLE_CODES) {
      const { auth, user } = await authAs(role, `${role.toLowerCase()}-seller`);
      const res = await sell(auth, {
        items: [{ medicineId: m.id, quantity: 1 }],
        payments: [cash('10')],
      });
      expect(res.status).toBe(201);
      expect(res.body.sale.cashier.id).toBe(user.id);
    }
  });

  it('rejects unknown and inactive medicines', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const inactive = await medicine('Discontinued syrup');
    await batch(inactive.id, 30, 10);
    await prisma.medicine.update({ where: { id: inactive.id }, data: { status: 'INACTIVE' } });

    const res = await sell(cashier.auth, {
      items: [
        { medicineId: inactive.id, quantity: 1 },
        { medicineId: '00000000-0000-4000-8000-000000000000', quantity: 1 },
      ],
      payments: [cash('20')],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.items).toEqual([
      { index: 0, field: 'medicineId', message: '"Discontinued syrup" is inactive' },
      { index: 1, field: 'medicineId', message: 'Medicine does not exist' },
    ]);
    await expectNothingSaved();
  });

  it('rejects malformed carts', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    await batch(m.id, 30, 10);
    const bodies = [
      { items: [] },
      { items: [{ medicineId: m.id, quantity: 0 }] },
      { items: [{ medicineId: m.id, quantity: 1.5 }] },
      {
        items: [
          { medicineId: m.id, quantity: 1 },
          { medicineId: m.id, quantity: 1 },
        ],
      },
      { items: [{ medicineId: m.id, quantity: 1 }], idempotencyKey: 'not-a-uuid' },
      { items: [{ medicineId: m.id, quantity: 1 }], idempotencyKey: undefined },
    ];
    for (const body of bodies) {
      const res = await sell(cashier.auth, { payments: [cash('10')], ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    await expectNothingSaved();
  });
});

describe('audit', () => {
  it('records SALE_CREATE with lines and payments', async () => {
    const { cashier, medicine, batch } = await salesSetup();
    const m = await medicine('Panadol 500mg');
    const b = await batch(m.id, 30, 10);

    const res = await sell(cashier.auth, {
      items: [{ medicineId: m.id, quantity: 2 }],
      payments: [cash('50')],
    });

    const [entry] = await auditEntries('SALE_CREATE');
    expect(entry).toMatchObject({
      userId: cashier.user.id,
      entityType: 'Sale',
      entityId: res.body.sale.id,
      after: {
        receiptNumber: res.body.sale.receiptNumber,
        grandTotal: '20.00',
        changeDue: '30.00',
        items: [{ medicineId: m.id, batchId: b.id, quantity: 2, lineTotal: '20.00' }],
        payments: [{ method: 'CASH', amount: '20.00', tendered: '50.00' }],
      },
    });
  });
});
