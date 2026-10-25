import { describe, expect, it } from 'vitest';
import { percentChange } from './dashboard-calc';

describe('percentChange', () => {
  it('compares today with yesterday to one decimal', () => {
    expect(percentChange('112.50', '100.00')).toEqual({ direction: 'up', text: '+12.5%' });
    expect(percentChange('97.00', '100.00')).toEqual({ direction: 'down', text: '−3.0%' });
    expect(percentChange('200', '100')).toEqual({ direction: 'up', text: '+100.0%' });
    // 1/3 = 33.33…% → 33.3; 2/3 = 66.66…% → 66.7.
    expect(percentChange('4', '3')).toEqual({ direction: 'up', text: '+33.3%' });
    expect(percentChange('5', '3')).toEqual({ direction: 'up', text: '+66.7%' });
  });

  it('calls a tiny change flat and handles losses', () => {
    expect(percentChange('100.01', '100.00')).toEqual({ direction: 'flat', text: '0.0%' });
    expect(percentChange('-50', '100')).toEqual({ direction: 'down', text: '−150.0%' });
  });

  it('has nothing to compare with a zero day', () => {
    expect(percentChange('50', '0')).toBeNull();
    expect(percentChange('50', '-10')).toBeNull();
    expect(percentChange('x', '10')).toBeNull();
  });
});
