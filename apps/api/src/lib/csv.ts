// CSV export for reports (RFC 4180). Money stays the exact decimal string
// the report produced; nothing is converted to a float on the way out.

import type { Response } from 'express';

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
  /**
   * Free text typed in by staff (names, references). Such cells are guarded
   * against spreadsheet formula injection. Numeric columns are not, so a
   * negative amount stays a number.
   */
  text?: boolean;
};

/** UTF-8 byte-order mark. */
export const BOM = String.fromCharCode(0xfeff);

// A cell starting with one of these is run as a formula by Excel/Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | boolean | null | undefined, text = false): string {
  if (value === null || value === undefined) return '';
  let cell = String(value);
  if (text && FORMULA_START.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) || cell !== cell.trim() ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row), c.text)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Sends a CSV download. The byte-order mark makes Excel read the file as
 * UTF-8, so names in Urdu or with accents survive.
 */
export function sendCsv(res: Response, filename: string, csv: string) {
  res
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
    .set('Cache-Control', 'no-store')
    .send(`${BOM}${csv}`);
}
