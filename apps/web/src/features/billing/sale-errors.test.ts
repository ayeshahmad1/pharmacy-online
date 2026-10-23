import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { addToCart, newCart } from './cart';
import { medicine } from './test-fixtures';
import { saleProblem, shortageMessage } from './sale-errors';

const a = medicine({ name: 'Panadol', unit: 'tablet' });
const b = medicine({ name: 'Brufen', unit: 'strip' });
const cart = addToCart(addToCart(newCart(), a, 5), b, 2);

describe('saleProblem', () => {
  it('maps a stock shortage to its cart line, telling expired stock apart', () => {
    const err = new ApiError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for some items', {
      items: [
        {
          index: 0,
          medicineId: a.id,
          requested: 5,
          available: 2,
          name: 'Panadol',
          unit: 'tablet',
          expiredQuantity: 0,
        },
        {
          index: 1,
          medicineId: b.id,
          requested: 2,
          available: 0,
          name: 'Brufen',
          unit: 'strip',
          expiredQuantity: 6,
        },
      ],
    });

    const problem = saleProblem(err, cart);

    expect(problem.lines[a.id]).toBe('Only 2 tablets in stock. Lower the quantity.');
    expect(problem.lines[b.id]).toBe("Only expired stock left (6 strips), which can't be sold");
    expect(problem.unavailable).toEqual([b.id]);
    expect(problem.stockUpdates).toEqual([
      { medicineId: a.id, available: 2, expired: 0 },
      { medicineId: b.id, available: 0, expired: 6 },
    ]);
    expect(problem.retryable).toBe(false);
  });

  it('puts the cashier discount cap on the bill discount', () => {
    const err = new ApiError(403, 'FORBIDDEN', 'Cashiers can give at most 10% discount', {
      maxPercent: 10,
      maxDiscount: '12.00',
      requested: '20.00',
    });
    expect(saleProblem(err, cart).billDiscount).toMatch(/at most 10%/);
  });

  it('maps line, bill discount and payment rejections', () => {
    const lines = saleProblem(
      new ApiError(400, 'BAD_REQUEST', 'Some items cannot be sold', {
        items: [{ index: 1, field: 'medicineId', message: '"Brufen" is inactive' }],
      }),
      cart,
    );
    expect(lines.lines).toEqual({ [b.id]: '"Brufen" is inactive' });

    const bill = saleProblem(
      new ApiError(400, 'BAD_REQUEST', 'Bill discount is too big', { field: 'discount' }),
      cart,
    );
    expect(bill.billDiscount).toBe('Bill discount is too big');

    const pay = saleProblem(
      new ApiError(400, 'BAD_REQUEST', 'Payment is short by 5.00', { field: 'payments' }),
      cart,
    );
    expect(pay.payment).toBe('Payment is short by 5.00');
  });

  it('marks network failures and server errors as safe to retry', () => {
    expect(saleProblem(new ApiError(0, 'NETWORK_ERROR', 'x'), cart)).toMatchObject({
      retryable: true,
      message: expect.stringMatching(/not be charged twice/),
    });
    expect(
      saleProblem(new ApiError(502, 'INTERNAL_ERROR', 'Server error (502)'), cart).retryable,
    ).toBe(true);
  });

  it('warns that a reused idempotency key means the bill was already saved', () => {
    const problem = saleProblem(new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'reused'), cart);
    expect(problem.alreadySaved).toBe(true);
    expect(problem.message).toMatch(/Check Sales/);
  });
});

describe('shortageMessage', () => {
  it('says out of stock when nothing is left at all', () => {
    expect(shortageMessage({ available: 0, expiredQuantity: 0, unit: 'tablet' })).toBe(
      'Out of stock',
    );
    expect(shortageMessage({ available: 1, expiredQuantity: 4, unit: 'bottle' })).toBe(
      'Only 1 bottle in stock (4 bottles expired). Lower the quantity.',
    );
  });
});
