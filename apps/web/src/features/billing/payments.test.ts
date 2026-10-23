import { describe, expect, it } from 'vitest';
import { cashSuggestions, emptyTenders, settle, toPayments, type TenderDraft } from './payments';

const tenders = (amounts: { cash?: string; card?: string; wallet?: string }): TenderDraft[] =>
  emptyTenders().map((t) => ({
    ...t,
    amount:
      (t.method === 'CASH' ? amounts.cash : t.method === 'CARD' ? amounts.card : amounts.wallet) ??
      '',
  }));

describe('settle', () => {
  it('gives change from cash', () => {
    const s = settle(45050n, tenders({ cash: '500' }));
    expect(s).toMatchObject({ ok: true, paid: 50000n, remaining: 0n, change: 4950n });
  });

  it('accepts an exact split across card, wallet and cash', () => {
    const s = settle(100000n, tenders({ card: '600', wallet: '300', cash: '100' }));
    expect(s).toMatchObject({ ok: true, nonCash: 90000n, cash: 10000n, change: 0n });
  });

  it('gives change on a split only out of the cash part', () => {
    const s = settle(100000n, tenders({ card: '700', cash: '500' }));
    expect(s).toMatchObject({ ok: true, change: 20000n });
  });

  it('reports what is still owed', () => {
    const s = settle(100000n, tenders({ cash: '400' }));
    expect(s.ok).toBe(false);
    expect(s.remaining).toBe(60000n);
    expect(s.error).toMatch(/Rs 600\.00 still to pay/);
  });

  it('refuses card and wallet above the bill: no change from card', () => {
    const s = settle(100000n, tenders({ card: '800', wallet: '300' }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/can't be more than the bill/);
  });

  it('refuses cash that is not needed', () => {
    const s = settle(100000n, tenders({ card: '1000', cash: '50' }));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/Cash is not needed/);
  });

  it('marks amounts that are not money', () => {
    const s = settle(1000n, tenders({ cash: '12.345' }));
    expect(s.ok).toBe(false);
    expect(s.fieldErrors.CASH).toBeTruthy();
  });

  it('needs no payment for a fully discounted bill', () => {
    expect(settle(0n, emptyTenders()).ok).toBe(true);
  });
});

describe('toPayments', () => {
  it('drops blank and zero rows, normalises amounts and keeps non-cash references', () => {
    const rows = tenders({ cash: '100.5', card: '0', wallet: '20' });
    rows[0]!.reference = 'ignored for cash';
    rows[2]!.reference = '  TX-991 ';
    expect(toPayments(rows)).toEqual([
      { method: 'CASH', amount: '100.50' },
      { method: 'MOBILE_WALLET', amount: '20.00', reference: 'TX-991' },
    ]);
  });
});

describe('cashSuggestions', () => {
  it('offers the exact amount and the next round notes', () => {
    expect(cashSuggestions(45050n)).toEqual([45050n, 50000n, 100000n, 500000n]);
    expect(cashSuggestions(50000n)).toEqual([50000n, 100000n, 500000n]);
    expect(cashSuggestions(0n)).toEqual([]);
  });
});
