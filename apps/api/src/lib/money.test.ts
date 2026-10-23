import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { allocate, formatPaisa, percentOf, sumPaisa, toPaisa } from './money';

describe('toPaisa / formatPaisa', () => {
  it('parses decimal strings exactly', () => {
    expect(toPaisa('120')).toBe(12000n);
    expect(toPaisa('120.5')).toBe(12050n);
    expect(toPaisa('120.05')).toBe(12005n);
    expect(toPaisa('0.01')).toBe(1n);
    expect(toPaisa('9999999999.99')).toBe(999999999999n);
  });

  it('parses Prisma Decimals', () => {
    expect(toPaisa(new Prisma.Decimal('45.10'))).toBe(4510n);
  });

  it('rejects anything that is not a plain non-negative amount', () => {
    for (const bad of ['', '-1', '1.234', 'abc', '1e3', '.5']) {
      expect(() => toPaisa(bad)).toThrow();
    }
  });

  it('formats with two decimals', () => {
    expect(formatPaisa(12050n)).toBe('120.50');
    expect(formatPaisa(5n)).toBe('0.05');
    expect(formatPaisa(0n)).toBe('0.00');
    expect(formatPaisa(-150n)).toBe('-1.50');
  });

  it('avoids the classic float error', () => {
    // 0.1 + 0.2 !== 0.3 in floats.
    expect(formatPaisa(toPaisa('0.1') + toPaisa('0.2'))).toBe('0.30');
  });
});

describe('percentOf', () => {
  it('rounds half-up to the paisa', () => {
    expect(percentOf(toPaisa('100'), '10')).toBe(1000n);
    expect(percentOf(toPaisa('33.33'), '50')).toBe(1667n); // 16.665 → 16.67
    expect(percentOf(toPaisa('10'), '12.5')).toBe(125n);
    expect(percentOf(toPaisa('0.01'), '49.99')).toBe(0n);
    expect(percentOf(toPaisa('0.01'), '50')).toBe(1n);
  });

  it('100% is the whole amount', () => {
    expect(percentOf(toPaisa('123.45'), '100')).toBe(12345n);
  });
});

describe('allocate', () => {
  it('splits proportionally and always adds up to the total', () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(1000n, [3n, 1n])).toEqual([750n, 250n]);
    const parts = allocate(9999n, [7n, 13n, 29n, 1n]);
    expect(sumPaisa(parts)).toBe(9999n);
  });

  it('gives leftover paisa to the largest remainders', () => {
    // 10 × 2/3 = 6.67 and 10 × 1/3 = 3.33: the bigger remainder gets the paisa.
    expect(allocate(10n, [2n, 1n])).toEqual([7n, 3n]);
  });

  it('never gives a share more than its weight when total ≤ sum of weights', () => {
    const weights = [1n, 1n, 1n, 997n];
    const parts = allocate(1000n, weights);
    parts.forEach((p, i) => expect(p).toBeLessThanOrEqual(weights[i]!));
  });

  it('allocates zero to nothing', () => {
    expect(allocate(0n, [0n, 0n])).toEqual([0n, 0n]);
  });

  it('refuses a positive total over zero weights', () => {
    expect(() => allocate(5n, [0n])).toThrow();
  });

  it('handles very large amounts without losing precision', () => {
    const parts = allocate(999999999999n, [999999999999n, 1n]);
    expect(sumPaisa(parts)).toBe(999999999999n);
  });
});
