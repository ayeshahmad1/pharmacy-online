// Date ranges for reports: presets like "Last 30 days" and custom from/to,
// kept in the URL. Dates are calendar days ("YYYY-MM-DD"); the API reads
// them as business days in the pharmacy's timezone.

import { MAX_DAILY_REPORT_DAYS, rangeDays, type ReportGroupBy } from '@pharmacy/shared';

export const RANGE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'year', label: 'This year' },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]['id'];
export const DEFAULT_PRESET: RangePreset = '30d';

export type DateRange = { from: string; to: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** The browser's calendar date as "YYYY-MM-DD". */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function presetRange(preset: RangePreset, today: string): DateRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = shiftDays(today, -1);
      return { from: day, to: day };
    }
    case '7d':
      return { from: shiftDays(today, -6), to: today };
    case '30d':
      return { from: shiftDays(today, -29), to: today };
    case '90d':
      return { from: shiftDays(today, -89), to: today };
    case 'month':
      return { from: monthStart, to: today };
    case 'last-month': {
      const lastDay = shiftDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isPreset = (value: string): value is RangePreset => RANGE_PRESETS.some((p) => p.id === value);

/**
 * The range a report shows, from its URL filters: explicit from/to win
 * (a custom range), else the named preset, else the last 30 days.
 */
export function resolveRange(
  filters: { range?: string; from?: string; to?: string },
  today = localToday(),
): DateRange & { preset: RangePreset | 'custom' } {
  const from = filters.from && DATE.test(filters.from) ? filters.from : '';
  const to = filters.to && DATE.test(filters.to) ? filters.to : '';
  if (from || to) {
    const end = to || (from > today ? from : today);
    const start = from || end;
    return start <= end
      ? { preset: 'custom', from: start, to: end }
      : { preset: 'custom', from: end, to: start };
  }
  const preset = filters.range && isPreset(filters.range) ? filters.range : DEFAULT_PRESET;
  return { preset, ...presetRange(preset, today) };
}

/** Day-by-day for short ranges, then weeks, then months; never more than the API allows. */
export function defaultGroupBy(range: DateRange): ReportGroupBy {
  const days = rangeDays(range.from, range.to);
  if (days <= 62) return 'day';
  if (days <= 182) return 'week';
  return 'month';
}

/** A grouping the API accepts for this range (daily is capped). */
export function allowedGroupBy(range: DateRange, wanted: string): ReportGroupBy {
  if (wanted === 'month' || wanted === 'week') return wanted;
  if (wanted === 'day' && rangeDays(range.from, range.to) <= MAX_DAILY_REPORT_DAYS) return 'day';
  return defaultGroupBy(range);
}

const dayMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const monthYear = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Axis/tooltip label for a period start: "25 Oct", "Wk of 19 Oct", "Oct 2026". */
export function periodLabel(period: string, groupBy: ReportGroupBy): string {
  const date = new Date(`${period}T00:00:00Z`);
  if (groupBy === 'month') return monthYear.format(date);
  if (groupBy === 'week') return `Wk of ${dayMonth.format(date)}`;
  return dayMonth.format(date);
}
