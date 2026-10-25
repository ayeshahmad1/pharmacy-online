import { describe, expect, it } from 'vitest';
import { allocate, formatMoney, lineTotal, paisaToAmount, percentOf, toPaisa } from './money';

describe('money helpers', () => {
  it('parses decimal strings into exact paisa', () => {
    expect(toPaisa('120')).toBe(12000n);
    expect(toPaisa('120.5')).toBe(12050n);
    expect(toPaisa(' 0.07 ')).toBe(7n);
    expect(toPaisa('9999999999.99')).toBe(999999999999n);
  });

  it('rejects text that is not an amount', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1,000', '.5']) expect(toPaisa(bad)).toBeNull();
  });

  it('formats paisa back to a two-decimal string', () => {
    expect(paisaToAmount(12050n)).toBe('120.50');
    expect(paisaToAmount(7n)).toBe('0.07');
    expect(paisaToAmount(-150n)).toBe('-1.50');
  });

  it('formats rupees with thousands separators', () => {
    expect(formatMoney('1234567.5')).toBe('Rs 1,234,567.50');
    expect(formatMoney('0')).toBe('Rs 0.00');
    expect(formatMoney(-123456n)).toBe('-Rs 1,234.56');
    expect(formatMoney('-25.5')).toBe('-Rs 25.50');
    expect(formatMoney('oops')).toBe('oops');
  });

  it('multiplies a unit price by a quantity without float error', () => {
    // 0.1 * 3 in floats is 0.30000000000000004.
    expect(lineTotal('0.10', 3)).toBe(30n);
    expect(lineTotal('19.99', 1000)).toBe(1999000n);
    expect(lineTotal('bad', 2)).toBeNull();
    expect(lineTotal('1', Number.NaN)).toBeNull();
  });

  it('takes a percentage rounded half-up to the paisa, like the API', () => {
    expect(percentOf(10000n, '10')).toBe(1000n);
    expect(percentOf(333n, '12.5')).toBe(42n); // 41.625 → 42
    expect(percentOf(5n, '10')).toBe(1n); // 0.5 → 1
    expect(percentOf(4n, '10')).toBe(0n);
  });

  it('splits an amount by weight exactly, leftovers to the largest remainders', () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocate(1000n, [3000n, 1000n])).toEqual([750n, 250n]);
    expect(allocate(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocate(7n, [0n, 0n])).toEqual([0n, 0n]);
  });
});
