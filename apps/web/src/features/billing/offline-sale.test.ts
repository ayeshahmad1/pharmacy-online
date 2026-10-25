import type { SellableMedicineDto } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { addToCart, newCart, priceCart, setLineDiscount, type Cart } from './cart';
import { buildOfflineSale, checkOfflineSale, settleOffline } from './offline-sale';
import { medicine } from './test-fixtures';

const cartWith = (...items: [SellableMedicineDto, number][]): Cart =>
  items.reduce((cart, [m, q]) => addToCart(cart, m, q), newCart());

const stockOf = (...meds: SellableMedicineDto[]) => new Map(meds.map((m) => [m.id, m]));

describe('checkOfflineSale', () => {
  const panadol = medicine({ name: 'Panadol', sellingPrice: '10.00', sellableQuantity: 5 });

  it('lets through a cart the local stock covers', () => {
    const cart = cartWith([panadol, 5]);
    expect(
      checkOfflineSale(cart, priceCart(cart), {
        stock: stockOf(panadol),
        cashierMaxDiscountPercent: 10,
        role: 'CASHIER',
      }),
    ).toBeNull();
  });

  it('refuses more than the device’s count of sellable stock, calling out expired units', () => {
    const cart = cartWith([panadol, 3]);
    const now = { ...panadol, sellableQuantity: 0, expiredQuantity: 4 };
    const problem = checkOfflineSale(cart, priceCart(cart), {
      stock: stockOf(now),
      cashierMaxDiscountPercent: 10,
      role: 'PHARMACIST',
    });
    expect(problem!.lines[panadol.id]).toMatch(/Only expired stock left/);
    expect(problem!.unavailable).toEqual([panadol.id]);
    expect(problem!.stockUpdates).toEqual([{ medicineId: panadol.id, available: 0, expired: 4 }]);
  });

  it('refuses medicines missing from the saved list', () => {
    const other = medicine({ name: 'Brufen' });
    const cart = cartWith([panadol, 1], [other, 1]);
    const problem = checkOfflineSale(cart, priceCart(cart), {
      stock: stockOf({ ...panadol, sellingPrice: '11.00' }),
      cashierMaxDiscountPercent: 10,
      role: 'ADMIN',
    });
    expect(problem!.lines[other.id]).toMatch(/Not in the medicine list/);
    // The cart's price is the newest the counter saw; the API checks it at sync.
    expect(problem!.lines[panadol.id]).toBeUndefined();
  });

  it('holds cashiers to the discount cap, but not pharmacists', () => {
    const cart = setLineDiscount(cartWith([panadol, 5]), panadol.id, {
      type: 'PERCENT',
      value: '20',
    });
    const check = { stock: stockOf(panadol), cashierMaxDiscountPercent: 10 };
    const problem = checkOfflineSale(cart, priceCart(cart), { ...check, role: 'CASHIER' });
    expect(problem!.billDiscount).toMatch(/at most 10% discount \(Rs 5.00/);
    expect(checkOfflineSale(cart, priceCart(cart), { ...check, role: 'PHARMACIST' })).toBeNull();
  });

  it('refuses everything without a saved catalogue', () => {
    const cart = cartWith([panadol, 1]);
    const problem = checkOfflineSale(cart, priceCart(cart), {
      stock: new Map(),
      cashierMaxDiscountPercent: null,
      role: 'ADMIN',
    });
    expect(problem!.message).toMatch(/no medicine list saved/);
  });
});

describe('settleOffline', () => {
  it('takes the change out of cash, as the API does', () => {
    expect(
      settleOffline(15000n, [
        { method: 'CARD', amount: '50.00', reference: 'A1' },
        { method: 'CASH', amount: '200.00' },
      ]),
    ).toEqual({
      change: 10000n,
      tendered: 25000n,
      payments: [
        { method: 'CARD', amount: '50.00', tendered: null, reference: 'A1' },
        { method: 'CASH', amount: '100.00', tendered: '200.00', reference: null },
      ],
    });
  });
});

describe('buildOfflineSale', () => {
  const panadol = medicine({ name: 'Panadol', sellingPrice: '10.00' });
  const batches = new Map([
    [
      panadol.id,
      [
        { id: 'b-old', batchNumber: 'OLD', expiryDate: '2026-10-24', quantity: 9 },
        { id: 'b-1', batchNumber: 'P1', expiryDate: '2026-12-01', quantity: 2 },
        { id: 'b-2', batchNumber: 'P2', expiryDate: '2027-03-01', quantity: 9 },
      ],
    ],
  ]);
  const now = new Date('2026-10-24T07:00:00.000Z');
  const user = { id: 'u-1', username: 'counter1', fullName: 'Counter One' };

  function build() {
    const cart = { ...cartWith([panadol, 4]), discount: { type: 'AMOUNT' as const, value: '3' } };
    const totals = priceCart(cart);
    return {
      cart,
      sale: buildOfflineSale({
        cart,
        totals,
        payments: [{ method: 'CASH', amount: '50' }],
        user,
        batches,
        today: '2026-10-24',
        now,
      }),
    };
  }

  it('queues the cart’s own request with the counter time and charged total', () => {
    const { cart, sale } = build();
    expect(sale.body).toEqual({
      idempotencyKey: cart.idempotencyKey,
      items: [{ medicineId: panadol.id, quantity: 4 }],
      discount: { type: 'AMOUNT', value: '3' },
      payments: [{ method: 'CASH', amount: '50' }],
      notes: undefined,
      offline: { soldAt: now.toISOString(), expectedTotal: '37.00' },
    });
  });

  it('prints a provisional receipt with predicted FEFO batches and exact totals', () => {
    const { cart, sale } = build();
    const r = sale.receipt;
    expect(r.receiptNumber).toMatch(/^OFF-[0-9A-F]{8}$/);
    expect(r.idempotencyKey).toBe(cart.idempotencyKey);
    expect(r).toMatchObject({
      soldAt: now.toISOString(),
      cashier: user,
      subtotal: '40.00',
      discountTotal: '3.00',
      grandTotal: '37.00',
      changeDue: '13.00',
      amountTendered: '50.00',
    });
    // The expired batch is skipped; the discount splits by quantity and adds up.
    expect(r.items.map((i) => [i.batch.batchNumber, i.quantity, i.discount, i.lineTotal])).toEqual([
      ['P1', 2, '1.50', '18.50'],
      ['P2', 2, '1.50', '18.50'],
    ]);
    expect(r.payments).toMatchObject([{ method: 'CASH', amount: '37.00', tendered: '50.00' }]);
  });
});
