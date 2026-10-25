// Charts plot money as whole paisa (an integer Number), never as a float of
// rupees, and every label goes back through money.ts, so what a chart shows
// is exactly what the API sent (CLAUDE.md rule 6). Paisa stay exact as a
// Number up to 2^53, far beyond any pharmacy's takings.

import { formatMoney, toSignedPaisa } from '@/lib/money';

/** "1234.50" → 123450. Negative amounts (a loss) are allowed. */
export function chartPaisa(amount: string): number {
  return Number(toSignedPaisa(amount) ?? 0n);
}

/** Full amount for tooltips and labels: 123450 → "Rs 1,234.50". */
export function chartMoney(paisa: number): string {
  return formatMoney(BigInt(Math.round(paisa)));
}

/** Compact axis tick in whole rupees: 0, 950, 1.2K, 15K, 1.5M. */
export function compactMoney(paisa: number): string {
  const rupees = Math.round(paisa / 100);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}K`;
  return `${sign}${abs}`;
}

const trim = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''));
