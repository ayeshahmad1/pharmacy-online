import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { formatPaisa, sumPaisa, toPaisa } from '../../lib/money';
import {
  type TenderInput,
  allocateFefo,
  discountCap,
  priceSale,
  settlePayments,
  splitLine,
} from './sales.calc';

const pkr = toPaisa;

function expectBadRequest(fn: () => unknown, message: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(400);
    expect((err as AppError).message).toMatch(message);
    return err as AppError;
  }
  throw new Error('Expected a 400 AppError');
}

describe('priceSale', () => {
  it('totals lines with no discounts', () => {
    const sale = priceSale([
      { quantity: 3, unitPrice: pkr('10.50') },
      { quantity: 1, unitPrice: pkr('99.99') },
    ]);
    expect(formatPaisa(sale.subtotal)).toBe('131.49');
    expect(sale.discountTotal).toBe(0n);
    expect(formatPaisa(sale.grandTotal)).toBe('131.49');
    expect(sale.lines.map((l) => formatPaisa(l.gross))).toEqual(['31.50', '99.99']);
  });

  it('applies amount and percent line discounts to quantity × price', () => {
    const sale = priceSale([
      { quantity: 2, unitPrice: pkr('50'), discount: { type: 'AMOUNT', value: '15' } },
      { quantity: 4, unitPrice: pkr('25'), discount: { type: 'PERCENT', value: '12.5' } },
    ]);
    expect(sale.lines.map((l) => formatPaisa(l.discount))).toEqual(['15.00', '12.50']);
    expect(formatPaisa(sale.subtotal)).toBe('200.00');
    expect(formatPaisa(sale.discountTotal)).toBe('27.50');
    expect(formatPaisa(sale.grandTotal)).toBe('172.50');
  });

  it('applies a bill discount after line discounts and spreads it by line value', () => {
    // Nets after line discounts: 90 and 30. 10% of 120 = 12 → 9 and 3.
    const sale = priceSale(
      [
        { quantity: 1, unitPrice: pkr('100'), discount: { type: 'AMOUNT', value: '10' } },
        { quantity: 3, unitPrice: pkr('10') },
      ],
      { type: 'PERCENT', value: '10' },
    );
    expect(sale.lines.map((l) => formatPaisa(l.discount))).toEqual(['19.00', '3.00']);
    expect(formatPaisa(sale.discountTotal)).toBe('22.00');
    expect(formatPaisa(sale.grandTotal)).toBe('108.00');
  });

  it('spreads an uneven bill discount so it still adds up exactly', () => {
    const sale = priceSale(
      [
        { quantity: 1, unitPrice: pkr('10') },
        { quantity: 1, unitPrice: pkr('10') },
        { quantity: 1, unitPrice: pkr('10') },
      ],
      { type: 'AMOUNT', value: '1' },
    );
    expect(sale.lines.map((l) => l.discount)).toEqual([34n, 33n, 33n]);
    expect(sumPaisa(sale.lines.map((l) => l.discount))).toBe(sale.discountTotal);
    expect(formatPaisa(sale.grandTotal)).toBe('29.00');
  });

  it('allows a 100% discount (a free item)', () => {
    const sale = priceSale([
      { quantity: 2, unitPrice: pkr('5'), discount: { type: 'PERCENT', value: '100' } },
    ]);
    expect(sale.grandTotal).toBe(0n);
  });

  it('rejects a line discount larger than the line', () => {
    const err = expectBadRequest(
      () =>
        priceSale([
          { quantity: 1, unitPrice: pkr('10') },
          { quantity: 2, unitPrice: pkr('5'), discount: { type: 'AMOUNT', value: '10.01' } },
        ]),
      /too large/,
    );
    expect(err.details).toMatchObject({ items: [{ index: 1, field: 'discount' }] });
  });

  it('rejects a bill discount larger than the bill after line discounts', () => {
    expectBadRequest(
      () =>
        priceSale(
          [{ quantity: 1, unitPrice: pkr('10'), discount: { type: 'AMOUNT', value: '5' } }],
          { type: 'AMOUNT', value: '5.01' },
        ),
      /Bill discount/,
    );
  });
});

describe('discountCap', () => {
  it('is the percentage of the subtotal', () => {
    expect(formatPaisa(discountCap(pkr('250'), 10))).toBe('25.00');
    expect(discountCap(pkr('250'), 0)).toBe(0n);
  });
});

describe('allocateFefo', () => {
  const batches = [
    { id: 'early', quantity: 3 },
    { id: 'middle', quantity: 0 },
    { id: 'late', quantity: 10 },
  ];

  it('takes from the first batch when it has enough', () => {
    expect(allocateFefo(batches, 2)).toEqual([{ batchId: 'early', quantity: 2 }]);
  });

  it('empties earlier batches before touching later ones, skipping empty ones', () => {
    expect(allocateFefo(batches, 7)).toEqual([
      { batchId: 'early', quantity: 3 },
      { batchId: 'late', quantity: 4 },
    ]);
  });

  it('can take everything there is', () => {
    expect(allocateFefo(batches, 13)).toEqual([
      { batchId: 'early', quantity: 3 },
      { batchId: 'late', quantity: 10 },
    ]);
  });

  it('returns null when the batches hold too little in total', () => {
    expect(allocateFefo(batches, 14)).toBeNull();
    expect(allocateFefo([], 1)).toBeNull();
  });
});

describe('splitLine', () => {
  it('gives one sale line per batch, splitting the discount by quantity', () => {
    const [line] = priceSale([
      { quantity: 3, unitPrice: pkr('10'), discount: { type: 'AMOUNT', value: '1' } },
    ]).lines;
    const lines = splitLine(line!, [
      { batchId: 'a', quantity: 2 },
      { batchId: 'b', quantity: 1 },
    ]);
    expect(lines.map((l) => [l.batchId, l.quantity, formatPaisa(l.discount)])).toEqual([
      ['a', 2, '0.67'],
      ['b', 1, '0.33'],
    ]);
    expect(lines.map((l) => formatPaisa(l.lineTotal))).toEqual(['19.33', '9.67']);
    expect(sumPaisa(lines.map((l) => l.lineTotal))).toBe(line!.gross - line!.discount);
  });

  it('never makes a batch line negative, even at a 100% discount', () => {
    const [line] = priceSale([
      { quantity: 7, unitPrice: pkr('0.01'), discount: { type: 'PERCENT', value: '100' } },
    ]).lines;
    const lines = splitLine(line!, [
      { batchId: 'a', quantity: 1 },
      { batchId: 'b', quantity: 6 },
    ]);
    for (const l of lines) expect(l.lineTotal).toBe(0n);
  });
});

describe('settlePayments', () => {
  const cash = (amount: string): TenderInput => ({
    method: 'CASH',
    amount: pkr(amount),
    reference: null,
  });
  const card = (amount: string): TenderInput => ({
    method: 'CARD',
    amount: pkr(amount),
    reference: 'AUTH123',
  });
  const wallet = (amount: string): TenderInput => ({
    method: 'MOBILE_WALLET',
    amount: pkr(amount),
    reference: 'TX9',
  });

  it('exact cash gives no change', () => {
    const s = settlePayments(pkr('150'), [cash('150')]);
    expect(s.change).toBe(0n);
    expect(s.payments).toEqual([
      { method: 'CASH', amount: pkr('150'), tendered: null, reference: null },
    ]);
  });

  it('cash over the total gives change and records what was handed over', () => {
    const s = settlePayments(pkr('172.50'), [cash('500')]);
    expect(formatPaisa(s.change)).toBe('327.50');
    expect(s.payments[0]).toMatchObject({ amount: pkr('172.50'), tendered: pkr('500') });
  });

  it('card alone must match exactly', () => {
    const s = settlePayments(pkr('99.99'), [card('99.99')]);
    expect(s.change).toBe(0n);
    expect(s.payments[0]).toMatchObject({ method: 'CARD', amount: pkr('99.99'), tendered: null });
  });

  it('splits across card, wallet and cash, with change only from cash', () => {
    const s = settlePayments(pkr('1000'), [card('400'), wallet('300'), cash('500')]);
    expect(formatPaisa(s.change)).toBe('200.00');
    expect(s.payments.map((p) => [p.method, formatPaisa(p.amount)])).toEqual([
      ['CARD', '400.00'],
      ['MOBILE_WALLET', '300.00'],
      ['CASH', '300.00'],
    ]);
    expect(sumPaisa(s.payments.map((p) => p.amount))).toBe(pkr('1000'));
  });

  it('rejects a short payment and says by how much', () => {
    const err = expectBadRequest(
      () => settlePayments(pkr('100'), [card('40'), cash('59.50')]),
      /short by 0.50/,
    );
    expect(err.details).toMatchObject({ due: '100.00', paid: '99.50', short: '0.50' });
  });

  it('rejects card or wallet amounts above the total (no change from cards)', () => {
    expectBadRequest(() => settlePayments(pkr('100'), [card('100.01')]), /exceed/);
    expectBadRequest(() => settlePayments(pkr('100'), [card('60'), wallet('41')]), /exceed/);
  });

  it('rejects cash that is not needed because cards already cover the bill', () => {
    expectBadRequest(() => settlePayments(pkr('100'), [card('100'), cash('20')]), /not needed/);
  });

  it('needs no payment for a fully discounted bill', () => {
    expect(settlePayments(0n, [])).toEqual({ payments: [], tendered: 0n, change: 0n });
  });

  it('rejects no payment for a bill that is due', () => {
    expectBadRequest(() => settlePayments(pkr('1'), []), /short by 1.00/);
  });
});
