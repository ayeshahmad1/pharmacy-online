import { describe, expect, it } from 'vitest';
import { availabilityStatus, nextExpiryStatus } from './availability';
import { medicine } from './test-fixtures';

describe('availabilityStatus', () => {
  it('names stock left only in expired batches', () => {
    expect(availabilityStatus(medicine({ sellableQuantity: 0, expiredQuantity: 4 }))).toEqual({
      tone: 'danger',
      label: 'Only expired stock',
    });
  });

  it('says out of stock, low stock or how much is in stock', () => {
    expect(availabilityStatus(medicine({ sellableQuantity: 0 })).label).toBe('Out of stock');
    expect(availabilityStatus(medicine({ sellableQuantity: 3, isLowStock: true }))).toEqual({
      tone: 'warning',
      label: 'Low: 3 tablets',
    });
    expect(availabilityStatus(medicine({ sellableQuantity: 1 }))).toEqual({
      tone: 'ok',
      label: '1 tablet',
    });
  });
});

describe('nextExpiryStatus', () => {
  const today = new Date(2026, 9, 24);
  it('warns when the next batch to sell expires soon', () => {
    expect(nextExpiryStatus(medicine({ nextExpiry: '2026-11-10' }), today)).toEqual({
      tone: 'danger',
      label: 'Exp 10 Nov 2026',
    });
    expect(nextExpiryStatus(medicine({ nextExpiry: '2027-06-30' }), today)?.tone).toBe('ok');
    expect(nextExpiryStatus(medicine({ nextExpiry: null }), today)).toBeNull();
  });
});
