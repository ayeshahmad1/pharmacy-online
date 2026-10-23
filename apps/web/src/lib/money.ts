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
