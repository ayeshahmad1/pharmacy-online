// Money on the client, in whole paisa (1 PKR = 100 paisa) using BigInt, so no
// JS float ever carries an amount (CLAUDE.md rule 6). The API sends and takes
// amounts as decimal strings like "120.50"; this only formats and multiplies
// them for display. The server stays the authority on every total it stores.

const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/** "120.5" → 12050n, or null when the text is not a money amount. */
export function toPaisa(amount: string): bigint | null {
  const match = AMOUNT.exec(amount.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** 12050n → "120.50". */
export function paisaToAmount(paisa: bigint): string {
  const sign = paisa < 0n ? '-' : '';
  const abs = paisa < 0n ? -paisa : paisa;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** "1234567.5" → "Rs 1,234,567.50". Shows unparseable input unchanged. */
export function formatMoney(amount: string | bigint): string {
  const paisa = typeof amount === 'bigint' ? amount : toPaisa(amount);
  if (paisa === null) return String(amount);
  const [whole, fraction] = paisaToAmount(paisa).split('.');
  const sign = whole!.startsWith('-') ? '-' : '';
  const digits = sign ? whole!.slice(1) : whole!;
  return `${sign}Rs ${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** Unit price × whole quantity, exactly. Null when either input is not valid. */
export function lineTotal(unitPrice: string, quantity: number): bigint | null {
  const paisa = toPaisa(unitPrice);
  if (paisa === null || !Number.isSafeInteger(quantity)) return null;
  return paisa * BigInt(quantity);
}

/**
 * `percent` (e.g. "12.5") of a non-negative amount, rounded half-up to the
 * paisa. Same rounding as the API, so a previewed discount matches the bill.
 */
export function percentOf(amount: bigint, percent: string): bigint {
  // Basis points: "12.5" → 1250. Same format as money, so reuse the parser.
  const basisPoints = toPaisa(percent) ?? 0n;
  return (amount * basisPoints + 5_000n) / 10_000n;
}

/**
 * Splits `total` across shares proportional to `weights`, exactly, the same
 * way the API spreads a bill discount over its lines: the parts add up to
 * `total` and leftover paisa go to the largest remainders (earlier index wins
 * a tie).
 */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (total === 0n) return weights.map(() => 0n);
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum <= 0n) return weights.map(() => 0n);

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

export const sumPaisa = (values: bigint[]): bigint => values.reduce((a, v) => a + v, 0n);
