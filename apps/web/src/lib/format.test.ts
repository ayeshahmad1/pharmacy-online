import { describe, expect, it } from 'vitest';
import { formatChange, formatDate, formatQuantity } from './format';

describe('formatting', () => {
  it('formats a date-only string without timezone drift', () => {
    expect(formatDate('2027-06-30')).toBe('30 Jun 2027');
    expect(formatDate('2027-01-01')).toBe('1 Jan 2027');
    expect(formatDate('not a date')).toBe('not a date');
  });

  it('pluralises units', () => {
    expect(formatQuantity(1, 'tablet')).toBe('1 tablet');
    expect(formatQuantity(1200, 'tablet')).toBe('1,200 tablets');
    expect(formatQuantity(0, 'bottle')).toBe('0 bottles');
    expect(formatQuantity(3, 'drops')).toBe('3 drops');
    expect(formatQuantity(5)).toBe('5');
  });

  it('shows signed changes', () => {
    expect(formatChange(20)).toBe('+20');
    expect(formatChange(-5)).toBe('−5');
  });
});
