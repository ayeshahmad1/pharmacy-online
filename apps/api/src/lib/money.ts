// Money arithmetic in whole paisa (1 PKR = 100 paisa) using BigInt, so no JS
// float ever carries an amount (CLAUDE.md rule 6). Amounts enter and leave as
// decimal strings or Prisma Decimals; everything in between is exact.

import type { Prisma } from '@prisma/client';

export type Paisa = bigint;

const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/** "120.5" or Decimal(120.50) → 12050n. Rejects negatives and more than 2 decimals. */
export function toPaisa(amount: string | Prisma.Decimal): Paisa {
  const text = typeof amount === 'string' ? amount.trim() : amount.toFixed(2);
  const match = AMOUNT.exec(text);
  if (!match) throw new Error(`Not a money amount: "${text}"`);
  const [, whole, fraction = ''] = match;
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** 12050n → "120.50". Accepts what Prisma takes for a Decimal column. */
export function formatPaisa(paisa: Paisa): string {
  const sign = paisa < 0n ? '-' : '';
  const abs = paisa < 0n ? -paisa : paisa;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** `percent` (e.g. "12.5") of a non-negative amount, rounded half-up to the paisa. */
export function percentOf(amount: Paisa, percent: string): Paisa {
  // Basis points: "12.5" → 1250. Same format as money, so reuse the parser.
  const basisPoints = toPaisa(percent);
  return (amount * basisPoints + 5_000n) / 10_000n;
}

/**
 * Splits `total` across shares proportional to `weights`, exactly: the parts
 * always add up to `total`. Leftover paisa go to the largest remainders
 * (earlier index wins a tie), so the result is deterministic. No part exceeds
 * ceil(total × weight / sum), so a part never exceeds its weight when
 * total ≤ sum of weights.
 */
export function allocate(total: Paisa, weights: bigint[]): Paisa[] {
  if (total === 0n) return weights.map(() => 0n);
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum <= 0n) throw new Error('Cannot allocate an amount over zero weights');

  const parts = weights.map((w) => (total * w) / sum);
  let leftover = total - parts.reduce((a, p) => a + p, 0n);
  const byRemainder = weights
    .map((w, index) => ({ index, remainder: (total * w) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of byRemainder) {
    if (leftover === 0n) break;
    parts[index]! += 1n;
    leftover -= 1n;
  }
  return parts;
}

export const sumPaisa = (values: Paisa[]): Paisa => values.reduce((a, v) => a + v, 0n);
