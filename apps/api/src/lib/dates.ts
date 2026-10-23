// Calendar-date helpers. Expiry dates are plain dates ("YYYY-MM-DD"), and
// whether a batch has expired depends on what day it is at the pharmacy, not
// on the server's or UTC's clock. Dates are compared as strings, which works
// because the format is fixed-width and zero-padded.

import { config } from './config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Today's date in the pharmacy's timezone, as "YYYY-MM-DD". */
export function businessToday(now: Date = new Date(), timeZone = config.BUSINESS_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Prisma returns `@db.Date` columns as midnight UTC. */
export const toDateOnly = (date: Date): string => date.toISOString().slice(0, 10);

/** The value to store in a `@db.Date` column for a "YYYY-MM-DD" string. */
export const fromDateOnly = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

export function addDays(date: string, days: number): string {
  return toDateOnly(new Date(fromDateOnly(date).getTime() + days * MS_PER_DAY));
}

export function addYears(date: string, years: number): string {
  const d = fromDateOnly(date);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return toDateOnly(d);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((fromDateOnly(to).getTime() - fromDateOnly(from).getTime()) / MS_PER_DAY);
}

/** A batch is expired from its expiry date onward (CLAUDE.md rule 2). */
export const isExpiredOn = (expiryDate: string, today: string): boolean => expiryDate <= today;
