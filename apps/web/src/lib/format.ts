// Display formatting for dates and quantities. Money lives in money.ts.

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * "2027-06-30" → "30 Jun 2027". Read as UTC so the calendar date never
 * shifts with the browser's timezone.
 */
export function formatDate(dateOnly: string): string {
  const date = new Date(`${dateOnly.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? dateOnly : dateFormat.format(date);
}

/** An ISO timestamp in the browser's local time, e.g. "23 Oct 2026, 14:05". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

/** 1200 tablet → "1,200 tablets". Units are stored lowercase and singular. */
export function formatQuantity(quantity: number, unit?: string): string {
  const n = quantity.toLocaleString('en-US');
  if (!unit) return n;
  return `${n} ${Math.abs(quantity) === 1 || unit.endsWith('s') ? unit : `${unit}s`}`;
}

/** Signed change, e.g. +20 or −5 (with a real minus sign). */
export function formatChange(quantity: number): string {
  return quantity > 0
    ? `+${quantity.toLocaleString('en-US')}`
    : `−${Math.abs(quantity).toLocaleString('en-US')}`;
}
