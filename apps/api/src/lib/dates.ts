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

/**
 * The instant a business day starts (midnight in the pharmacy's timezone),
 * for filtering timestamps such as Sale.soldAt by day.
 */
export function startOfBusinessDay(date: string, timeZone = config.BUSINESS_TIMEZONE): Date {
  const midnightUtc = fromDateOnly(date).getTime();
  // Guess with the zone's offset at UTC midnight, then correct once with the
  // offset at the guess, which handles a DST change between the two.
  const guess = midnightUtc - zoneOffsetMs(midnightUtc, timeZone);
  return new Date(midnightUtc - zoneOffsetMs(guess, timeZone));
}

/** How far ahead of UTC the zone's wall clock is at `at`, in ms. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)!.value);
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - (at - (at % 1000));
}
