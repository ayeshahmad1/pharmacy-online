import { describe, expect, it } from 'vitest';
import {
  alertConditions,
  expiryCondition,
  quantityText,
  reconcile,
  sameJson,
  stockCondition,
} from './alerts.rules';

const today = '2026-10-25';
const stockRow = {
  medicineId: 'm1',
  name: 'Panadol 500mg',
  unit: 'tablet',
  reorderLevel: 20,
  sellable: 8,
  expired: 0,
};
const batchRow = {
  batchId: 'b1',
  batchNumber: 'PN-01',
  expiryDate: '2026-11-10',
  medicineId: 'm1',
  name: 'Panadol 500mg',
  unit: 'tablet',
  quantity: 40,
};

describe('stock alerts', () => {
  it('warns about low stock', () => {
    expect(stockCondition(stockRow)).toEqual({
      key: 'LOW_STOCK:m1',
      type: 'LOW_STOCK',
      severity: 'WARNING',
      medicineId: 'm1',
      batchId: null,
      message: 'Panadol 500mg is running low: 8 tablets left, reorder level 20',
      details: { quantity: 8, unit: 'tablet', reorderLevel: 20, expiredQuantity: 0 },
    });
  });

  it('raises out of stock as a separate, critical alert', () => {
    const out = stockCondition({ ...stockRow, sellable: 0, expired: 5 });
    expect(out).toMatchObject({
      key: 'OUT_OF_STOCK:m1',
      type: 'OUT_OF_STOCK',
      severity: 'CRITICAL',
    });
    expect(out.message).toBe('Panadol 500mg is out of stock (5 tablets expired on the shelf)');
  });
});

describe('expiry alerts', () => {
  it('warns about a batch expiring soon', () => {
    expect(expiryCondition(batchRow, today)).toMatchObject({
      key: 'EXPIRING_SOON:b1',
      severity: 'WARNING',
      batchId: 'b1',
      message: 'Panadol 500mg batch PN-01 expires on 2026-11-10: 40 tablets in stock',
    });
  });

  it('turns critical from the expiry date itself', () => {
    const expired = expiryCondition({ ...batchRow, expiryDate: today }, today);
    expect(expired).toMatchObject({ key: 'EXPIRED:b1', type: 'EXPIRED', severity: 'CRITICAL' });
    expect(expired.message).toMatch(/write it off$/);
  });

  it('lists stock and expiry conditions together', () => {
    expect(alertConditions([stockRow], [batchRow], today).map((c) => c.key)).toEqual([
      'LOW_STOCK:m1',
      'EXPIRING_SOON:b1',
    ]);
  });
});

describe('quantityText', () => {
  it('pluralises simple units', () => {
    expect(quantityText(1, 'tablet')).toBe('1 tablet');
    expect(quantityText(1200, 'strip')).toBe('1,200 strips');
    expect(quantityText(3, 'ml')).toBe('3 ml');
  });
});

describe('reconcile', () => {
  const low = stockCondition(stockRow);
  const expiring = expiryCondition(batchRow, today);
  const openLow = {
    id: 'a1',
    openKey: low.key,
    severity: low.severity,
    message: low.message,
    // jsonb hands keys back in its own order.
    details: { unit: 'tablet', quantity: 8, expiredQuantity: 0, reorderLevel: 20 },
  };

  it('opens new conditions and leaves unchanged ones alone', () => {
    const plan = reconcile([openLow], [low, expiring]);
    expect(plan.toOpen.map((c) => c.key)).toEqual([expiring.key]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toResolve).toEqual([]);
  });

  it('refreshes an open alert whose numbers changed', () => {
    const lower = stockCondition({ ...stockRow, sellable: 3 });
    const plan = reconcile([openLow], [lower]);
    expect(plan.toUpdate).toEqual([{ id: 'a1', condition: lower }]);
    expect(plan.toOpen).toEqual([]);
  });

  it('resolves alerts whose condition is gone, including on escalation', () => {
    // Low stock ran out: LOW_STOCK resolves, OUT_OF_STOCK opens as a new alert.
    const out = stockCondition({ ...stockRow, sellable: 0 });
    const plan = reconcile([openLow], [out]);
    expect(plan.toResolve).toEqual(['a1']);
    expect(plan.toOpen.map((c) => c.key)).toEqual(['OUT_OF_STOCK:m1']);
  });

  it('compares JSON regardless of key order', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});
