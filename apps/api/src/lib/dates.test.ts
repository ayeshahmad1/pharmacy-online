import { describe, expect, it } from 'vitest';
import {
  addDays,
  addYears,
  businessToday,
  daysBetween,
  fromDateOnly,
  isExpiredOn,
  startOfBusinessDay,
  toDateOnly,
} from './dates';

describe('businessToday', () => {
  it("uses the pharmacy's timezone, not UTC", () => {
    // 20:30 UTC on 31 Dec is already 1 Jan in Karachi (UTC+5).
    const now = new Date('2026-12-31T20:30:00.000Z');
    expect(businessToday(now, 'Asia/Karachi')).toBe('2027-01-01');
    expect(businessToday(now, 'UTC')).toBe('2026-12-31');
  });

  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(businessToday(new Date('2027-03-05T06:00:00.000Z'), 'Asia/Karachi')).toBe('2027-03-05');
  });
});

describe('date arithmetic', () => {
  it('round-trips a date-only value through the DB representation', () => {
    expect(fromDateOnly('2027-06-30').toISOString()).toBe('2027-06-30T00:00:00.000Z');
    expect(toDateOnly(fromDateOnly('2027-06-30'))).toBe('2027-06-30');
  });

  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2027-01-31', 1)).toBe('2027-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2027-05-10', 90)).toBe('2027-08-08');
  });

  it('adds years', () => {
    expect(addYears('2026-10-23', 10)).toBe('2036-10-23');
  });

  it('counts whole days between dates, negative when going backwards', () => {
    expect(daysBetween('2027-01-01', '2027-01-31')).toBe(30);
    expect(daysBetween('2027-01-31', '2027-01-01')).toBe(-30);
    expect(daysBetween('2027-01-01', '2027-01-01')).toBe(0);
    expect(daysBetween('2026-12-31', '2028-01-01')).toBe(366);
  });
});

describe('isExpiredOn', () => {
  it('a batch is expired from its expiry date onward', () => {
    expect(isExpiredOn('2027-06-30', '2027-06-29')).toBe(false);
    expect(isExpiredOn('2027-06-30', '2027-06-30')).toBe(true);
    expect(isExpiredOn('2027-06-30', '2027-07-01')).toBe(true);
  });
});

describe('startOfBusinessDay', () => {
  it('is local midnight in the pharmacy timezone', () => {
    // Karachi is UTC+5 all year.
    expect(startOfBusinessDay('2026-10-23', 'Asia/Karachi').toISOString()).toBe(
      '2026-10-22T19:00:00.000Z',
    );
    expect(startOfBusinessDay('2026-10-23', 'UTC').toISOString()).toBe('2026-10-23T00:00:00.000Z');
  });

  it('handles zones behind UTC and DST days', () => {
    // New York switches to EDT (UTC-4) on 2027-03-14; midnight is still EST (UTC-5).
    expect(startOfBusinessDay('2027-03-14', 'America/New_York').toISOString()).toBe(
      '2027-03-14T05:00:00.000Z',
    );
    expect(startOfBusinessDay('2027-03-15', 'America/New_York').toISOString()).toBe(
      '2027-03-15T04:00:00.000Z',
    );
  });
});
