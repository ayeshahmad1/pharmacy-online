import { describe, expect, it } from 'vitest';
import { daysUntil, expiryStatus, stockStatus } from './stock-status';

describe('expiryStatus', () => {
  it('flags expired batches', () => {
    expect(expiryStatus({ isExpired: true, daysToExpiry: 0 })).toEqual({
      tone: 'danger',
      label: 'Expired',
    });
    expect(expiryStatus({ isExpired: false, daysToExpiry: -3 }).label).toBe('Expired');
  });

  it('marks the next 30 days critical and the next 90 a warning', () => {
    expect(expiryStatus({ isExpired: false, daysToExpiry: 1 })).toEqual({
      tone: 'danger',
      label: 'Expires tomorrow',
    });
    expect(expiryStatus({ isExpired: false, daysToExpiry: 30 }).tone).toBe('danger');
    expect(expiryStatus({ isExpired: false, daysToExpiry: 31 })).toEqual({
      tone: 'warning',
      label: '31 days left',
    });
    expect(expiryStatus({ isExpired: false, daysToExpiry: 90 }).tone).toBe('warning');
    expect(expiryStatus({ isExpired: false, daysToExpiry: 91 }).tone).toBe('ok');
  });
});

describe('stockStatus', () => {
  it('puts out of stock above low stock', () => {
    expect(stockStatus({ sellableQuantity: 0, isLowStock: true })).toEqual({
      tone: 'danger',
      label: 'Out of stock',
    });
    expect(stockStatus({ sellableQuantity: 4, isLowStock: true }).label).toBe('Low stock');
    expect(stockStatus({ sellableQuantity: 40, isLowStock: false }).tone).toBe('ok');
  });
});

describe('daysUntil', () => {
  const today = new Date(2026, 9, 23, 18, 30);

  it('counts calendar days regardless of the time of day', () => {
    expect(daysUntil('2026-10-23', today)).toBe(0);
    expect(daysUntil('2026-10-24', today)).toBe(1);
    expect(daysUntil('2026-10-20', today)).toBe(-3);
    expect(daysUntil('2027-10-23', today)).toBe(365);
  });
});
