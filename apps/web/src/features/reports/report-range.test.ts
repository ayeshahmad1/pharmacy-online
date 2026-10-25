import { describe, expect, it } from 'vitest';
import { chartMoney, chartPaisa, compactMoney } from '@/components/charts/chart-values';
import {
  allowedGroupBy,
  defaultGroupBy,
  localToday,
  periodLabel,
  presetRange,
  resolveRange,
} from './report-range';

const today = '2026-10-25';

describe('presetRange', () => {
  it('covers the usual reporting windows, today included', () => {
    expect(presetRange('today', today)).toEqual({ from: today, to: today });
    expect(presetRange('yesterday', today)).toEqual({ from: '2026-10-24', to: '2026-10-24' });
    expect(presetRange('7d', today)).toEqual({ from: '2026-10-19', to: today });
    expect(presetRange('30d', today)).toEqual({ from: '2026-09-26', to: today });
    expect(presetRange('month', today)).toEqual({ from: '2026-10-01', to: today });
    expect(presetRange('year', today)).toEqual({ from: '2026-01-01', to: today });
  });

  it('finds last month across a year end', () => {
    expect(presetRange('last-month', '2027-01-15')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(presetRange('last-month', '2026-03-31')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
});

describe('resolveRange', () => {
  it('defaults to the last 30 days', () => {
    expect(resolveRange({}, today)).toEqual({ preset: '30d', from: '2026-09-26', to: today });
    expect(resolveRange({ range: 'nonsense' }, today).preset).toBe('30d');
    expect(resolveRange({ range: 'month' }, today)).toMatchObject({
      preset: 'month',
      from: '2026-10-01',
    });
  });

  it('prefers explicit dates, fixing a missing or reversed end', () => {
    expect(resolveRange({ range: '7d', from: '2026-10-01', to: '2026-10-10' }, today)).toEqual({
      preset: 'custom',
      from: '2026-10-01',
      to: '2026-10-10',
    });
    expect(resolveRange({ from: '2026-10-01' }, today)).toMatchObject({
      from: '2026-10-01',
      to: today,
    });
    expect(resolveRange({ from: '2026-10-10', to: '2026-10-01' }, today)).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-10',
    });
    expect(resolveRange({ from: 'bad' }, today).preset).toBe('30d');
  });

  it('reads the browser calendar date', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('grouping', () => {
  it('picks a grouping that keeps charts readable', () => {
    expect(defaultGroupBy({ from: '2026-10-01', to: '2026-10-25' })).toBe('day');
    expect(defaultGroupBy({ from: '2026-06-01', to: '2026-10-25' })).toBe('week');
    expect(defaultGroupBy({ from: '2025-01-01', to: '2026-10-25' })).toBe('month');
  });

  it('never asks for more days than the API allows', () => {
    const long = { from: '2024-01-01', to: '2026-10-25' };
    expect(allowedGroupBy(long, 'day')).toBe('month');
    expect(allowedGroupBy(long, 'week')).toBe('week');
    expect(allowedGroupBy({ from: '2026-10-01', to: today }, 'day')).toBe('day');
    expect(allowedGroupBy({ from: '2026-10-01', to: today }, '')).toBe('day');
  });

  it('labels periods', () => {
    expect(periodLabel('2026-10-25', 'day')).toBe('25 Oct');
    expect(periodLabel('2026-10-19', 'week')).toBe('Wk of 19 Oct');
    expect(periodLabel('2026-10-01', 'month')).toBe('Oct 2026');
  });
});

describe('chart values', () => {
  it('plots money as exact whole paisa', () => {
    expect(chartPaisa('1234.50')).toBe(123450);
    expect(chartPaisa('0.07')).toBe(7);
    expect(chartPaisa('-25.00')).toBe(-2500);
    expect(chartMoney(123450)).toBe('Rs 1,234.50');
  });

  it('shortens axis ticks', () => {
    expect(compactMoney(0)).toBe('0');
    expect(compactMoney(95_000)).toBe('950');
    expect(compactMoney(120_000)).toBe('1.2K');
    expect(compactMoney(1_500_000)).toBe('15K');
    expect(compactMoney(150_000_000)).toBe('1.5M');
    expect(compactMoney(-200_000)).toBe('-2K');
  });
});
