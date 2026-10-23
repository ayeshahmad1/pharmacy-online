import type { SellableMedicineDto } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import {
  MAX_LINE_QUANTITY,
  addToCart,
  cartUnits,
  newCart,
  parseDiscount,
  parseScan,
  priceCart,
  removeLine,
  setLineDiscount,
  setQuantity,
  stockShortfall,
  toSaleBody,
  type Cart,
} from './cart';
import { medicine } from './test-fixtures';

const cartWith = (...items: [SellableMedicineDto, number][]): Cart =>
  items.reduce((cart, [m, q]) => addToCart(cart, m, q), newCart());

describe('cart lines', () => {
  it('adds a medicine once and merges repeat adds into its line', () => {
    const a = medicine();
    const b = medicine();
    let cart = addToCart(newCart(), a);
    cart = addToCart(cart, b, 2);
    cart = addToCart(cart, { ...a, sellableQuantity: 7 }, 3);

    expect(cart.lines.map((l) => [l.medicine.id, l.quantity])).toEqual([
      [a.id, 4],
      [b.id, 2],
    ]);
    // The newest lookup's stock replaces the old snapshot.
    expect(cart.lines[0]!.medicine.sellableQuantity).toBe(7);
    expect(cartUnits(cart)).toBe(6);
  });

  it('keeps quantities whole and within 1..max', () => {
    const a = medicine();
    let cart = cartWith([a, 1]);
    expect(setQuantity(cart, a.id, 0).lines[0]!.quantity).toBe(1);
    expect(setQuantity(cart, a.id, 2.7).lines[0]!.quantity).toBe(2);
    expect(setQuantity(cart, a.id, Number.NaN).lines[0]!.quantity).toBe(1);
    cart = setQuantity(cart, a.id, MAX_LINE_QUANTITY + 5);
    expect(cart.lines[0]!.quantity).toBe(MAX_LINE_QUANTITY);
  });

  it('removes a line and keeps the bill key', () => {
    const a = medicine();
    const cart = cartWith([a, 1], [medicine(), 1]);
    const after = removeLine(cart, a.id);
    expect(after.lines).toHaveLength(1);
    expect(after.idempotencyKey).toBe(cart.idempotencyKey);
  });

  it('gives every new bill its own idempotency key', () => {
    expect(newCart().idempotencyKey).not.toBe(newCart().idempotencyKey);
  });

  it('warns when the quantity is above the stock last seen', () => {
    const line = cartWith([medicine({ sellableQuantity: 3 }), 5]).lines[0]!;
    expect(stockShortfall(line)).toBe(2);
    expect(stockShortfall({ ...line, quantity: 3 })).toBe(0);
  });
});

describe('priceCart', () => {
  it('totals quantity × catalogue price with no discounts', () => {
    const totals = priceCart(
      cartWith([medicine({ sellingPrice: '12.50' }), 3], [medicine({ sellingPrice: '0.10' }), 3]),
    );
    expect(totals.subtotal).toBe(3780n);
    expect(totals.discountTotal).toBe(0n);
    expect(totals.grandTotal).toBe(3780n);
    expect(totals.valid).toBe(true);
  });

  it('applies line discounts as an amount or a percentage of the line', () => {
    const a = medicine({ sellingPrice: '100.00' });
    const b = medicine({ sellingPrice: '33.30' });
    let cart = cartWith([a, 2], [b, 1]);
    cart = setLineDiscount(cart, a.id, { type: 'AMOUNT', value: '15' });
    cart = setLineDiscount(cart, b.id, { type: 'PERCENT', value: '12.5' });

    const totals = priceCart(cart);
    expect(totals.lines.map((l) => l.lineDiscount)).toEqual([1500n, 416n]); // 4.1625 → 4.16
    expect(totals.lineDiscounts).toBe(1916n);
    expect(totals.grandTotal).toBe(20000n + 3330n - 1916n);
  });

  it('spreads the bill discount over lines by their value after line discounts', () => {
    const a = medicine({ sellingPrice: '300.00' });
    const b = medicine({ sellingPrice: '100.00' });
    let cart = cartWith([a, 1], [b, 1]);
    cart = { ...cart, discount: { type: 'AMOUNT', value: '10' } };

    const totals = priceCart(cart);
    expect(totals.lines.map((l) => l.billShare)).toEqual([750n, 250n]);
    expect(totals.lines.map((l) => l.total)).toEqual([29250n, 9750n]);
    expect(totals.billDiscount).toBe(1000n);
    expect(totals.grandTotal).toBe(39000n);
  });

  it('takes a percentage bill discount of the total after line discounts', () => {
    const a = medicine({ sellingPrice: '200.00' });
    let cart = setLineDiscount(cartWith([a, 1]), a.id, { type: 'AMOUNT', value: '50' });
    cart = { ...cart, discount: { type: 'PERCENT', value: '10' } };
    const totals = priceCart(cart);
    expect(totals.billDiscount).toBe(1500n);
    expect(totals.grandTotal).toBe(13500n);
  });

  it('allows a fully discounted bill', () => {
    const cart = { ...cartWith([medicine(), 1]), discount: { type: 'PERCENT', value: '100' } };
    const totals = priceCart(cart as Cart);
    expect(totals.grandTotal).toBe(0n);
    expect(totals.valid).toBe(true);
  });

  it('flags discounts larger than what they apply to and ignores them in the totals', () => {
    const a = medicine({ sellingPrice: '10.00' });
    let cart = setLineDiscount(cartWith([a, 1]), a.id, { type: 'AMOUNT', value: '11' });
    let totals = priceCart(cart);
    expect(totals.lines[0]!.error).toMatch(/more than the line total/);
    expect(totals.grandTotal).toBe(1000n);
    expect(totals.valid).toBe(false);

    cart = { ...setLineDiscount(cart, a.id, null), discount: { type: 'AMOUNT', value: '10.01' } };
    totals = priceCart(cart);
    expect(totals.billDiscountError).toMatch(/more than the bill total/);
    expect(totals.valid).toBe(false);
  });

  it('flags discount values that are not amounts or percentages', () => {
    expect(parseDiscount({ type: 'PERCENT', value: '150' }).error).toMatch(/at most 100/);
    expect(parseDiscount({ type: 'AMOUNT', value: '1.234' }).error).toBeTruthy();
    expect(parseDiscount({ type: 'AMOUNT', value: '0' }).error).toMatch(/more than zero/);
    expect(parseDiscount({ type: 'AMOUNT', value: '  ' })).toEqual({
      discount: undefined,
      error: null,
    });
  });
});

describe('toSaleBody', () => {
  it('sends items in cart order with discounts, never a price', () => {
    const a = medicine();
    const b = medicine();
    let cart = cartWith([a, 2], [b, 1]);
    cart = setLineDiscount(cart, b.id, { type: 'PERCENT', value: '5' });
    cart = { ...cart, discount: { type: 'AMOUNT', value: '3.5' }, notes: '  regular  ' };

    const body = toSaleBody(cart, [{ method: 'CASH', amount: '100.00' }]);
    expect(body).toEqual({
      idempotencyKey: cart.idempotencyKey,
      items: [
        { medicineId: a.id, quantity: 2 },
        { medicineId: b.id, quantity: 1, discount: { type: 'PERCENT', value: '5' } },
      ],
      discount: { type: 'AMOUNT', value: '3.5' },
      payments: [{ method: 'CASH', amount: '100.00' }],
      notes: 'regular',
    });
  });

  it('leaves out blank discounts and notes', () => {
    const a = medicine();
    const cart = setLineDiscount(cartWith([a, 1]), a.id, { type: 'AMOUNT', value: '' });
    const body = toSaleBody(cart, []);
    expect(body.items[0]).toEqual({ medicineId: a.id, quantity: 1 });
    expect(body).not.toHaveProperty('discount');
    expect(body.notes).toBeUndefined();
  });
});

describe('parseScan', () => {
  it('reads an optional quantity prefix before the term', () => {
    expect(parseScan('8964000123457')).toEqual({ quantity: 1, term: '8964000123457' });
    expect(parseScan('3*8964000123457')).toEqual({ quantity: 3, term: '8964000123457' });
    expect(parseScan(' 12 * pana ')).toEqual({ quantity: 12, term: 'pana' });
    expect(parseScan('0*x')).toEqual({ quantity: 1, term: 'x' });
    expect(parseScan('4*')).toEqual({ quantity: 4, term: '' });
    expect(parseScan('vitamin b12')).toEqual({ quantity: 1, term: 'vitamin b12' });
  });
});
