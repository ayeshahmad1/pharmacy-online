import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { type Paisa, sumPaisa } from '../../lib/money';
import { type RefundCapacity, type ReturnLineState, lineRefund, planRefunds } from './returns.calc';

const line = (over: Partial<ReturnLineState> = {}): ReturnLineState => ({
  quantity: 3,
  lineTotal: 1000n,
  reservedQuantity: 0,
  reservedRefund: 0n,
  ...over,
});

/** Returns `parts` one after another and gives each refund. */
function returnInParts(total: Paisa, quantity: number, parts: number[]): Paisa[] {
  const state = line({ quantity, lineTotal: total });
  return parts.map((q) => {
    const refund = lineRefund(state, q);
    state.reservedQuantity += q;
    state.reservedRefund += refund;
    return refund;
  });
}

describe('lineRefund', () => {
  it('refunds pro rata, rounded down to the paisa', () => {
    expect(lineRefund(line(), 1)).toBe(333n);
    expect(lineRefund(line(), 2)).toBe(666n);
  });

  it('gives the whole line total when everything comes back at once', () => {
    expect(lineRefund(line(), 3)).toBe(1000n);
  });

  it('gives the last units whatever is left, so the parts add up exactly', () => {
    expect(returnInParts(1000n, 3, [1, 1, 1])).toEqual([333n, 333n, 334n]);
    expect(returnInParts(1000n, 3, [2, 1])).toEqual([666n, 334n]);
  });

  it('adds up to the line total for every way of splitting a line', () => {
    const splits = (n: number): number[][] =>
      n === 0
        ? [[]]
        : [1, 2, 3].filter((k) => k <= n).flatMap((k) => splits(n - k).map((s) => [k, ...s]));
    for (const total of [0n, 1n, 2n, 7n, 999n, 1000n, 123457n]) {
      for (const parts of splits(6)) {
        const refunds = returnInParts(total, 6, parts);
        expect(sumPaisa(refunds)).toBe(total);
        for (const r of refunds) expect(r >= 0n).toBe(true);
      }
    }
  });

  it('stays exact when a reserved return is rejected and the units come back later', () => {
    // R1 (1 unit) and R2 (1 unit) are reserved; R2 is rejected, freeing its
    // unit and amount; R3 then takes the last two units.
    const r1 = lineRefund(line(), 1);
    const r2 = lineRefund(line({ reservedQuantity: 1, reservedRefund: r1 }), 1);
    expect([r1, r2]).toEqual([333n, 333n]);
    const r3 = lineRefund(line({ reservedQuantity: 1, reservedRefund: r1 }), 2);
    expect(r1 + r3).toBe(1000n);
  });

  it('refunds nothing for a fully discounted line', () => {
    expect(lineRefund(line({ lineTotal: 0n }), 2)).toBe(0n);
  });

  it('refuses more than is left on the line', () => {
    expect(() => lineRefund(line({ reservedQuantity: 2 }), 2)).toThrow();
    expect(() => lineRefund(line(), 0)).toThrow();
  });
});

describe('planRefunds', () => {
  const capacity = (entries: [string, Paisa][]) => new Map(entries) as RefundCapacity;

  it('fills cash first, then card, then wallet when no split is given', () => {
    const cap = capacity([
      ['MOBILE_WALLET', 500n],
      ['CARD', 300n],
      ['CASH', 200n],
    ]);
    expect(planRefunds(600n, cap, undefined)).toEqual([
      { method: 'CASH', amount: 200n, reference: null },
      { method: 'CARD', amount: 300n, reference: null },
      { method: 'MOBILE_WALLET', amount: 100n, reference: null },
    ]);
  });

  it('skips methods with nothing left and gives no rows for a zero refund', () => {
    const cap = capacity([
      ['CASH', 0n],
      ['CARD', 300n],
    ]);
    expect(planRefunds(100n, cap, undefined)).toEqual([
      { method: 'CARD', amount: 100n, reference: null },
    ]);
    expect(planRefunds(0n, cap, undefined)).toEqual([]);
  });

  it('accepts a split within each method’s cap that adds up to the refund', () => {
    const cap = capacity([
      ['CASH', 200n],
      ['CARD', 300n],
    ]);
    const split = [
      { method: 'CARD' as const, amount: 250n, reference: 'RF-1' },
      { method: 'CASH' as const, amount: 50n, reference: null },
    ];
    expect(planRefunds(300n, cap, split)).toEqual(split);
  });

  const rejects = (fn: () => unknown, message: RegExp) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).message + JSON.stringify((err as AppError).details)).toMatch(
        message,
      );
      return;
    }
    throw new Error('Expected a rejection');
  };

  it('refuses a method the sale was not paid with', () => {
    const cap = capacity([['CASH', 1000n]]);
    rejects(
      () => planRefunds(100n, cap, [{ method: 'CARD', amount: 100n, reference: null }]),
      /Nothing can be refunded by card/,
    );
  });

  it('refuses more than a method can still refund', () => {
    const cap = capacity([
      ['CASH', 100n],
      ['CARD', 900n],
    ]);
    rejects(
      () => planRefunds(300n, cap, [{ method: 'CASH', amount: 300n, reference: null }]),
      /At most 1\.00 can be refunded by cash/,
    );
  });

  it('refuses a split that does not add up to the refund due', () => {
    const cap = capacity([['CASH', 1000n]]);
    rejects(
      () => planRefunds(300n, cap, [{ method: 'CASH', amount: 200n, reference: null }]),
      /add up to 2\.00 but the refund due is 3\.00/,
    );
  });
});
