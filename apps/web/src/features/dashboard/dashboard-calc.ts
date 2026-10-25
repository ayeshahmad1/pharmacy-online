import { toSignedPaisa } from '@/lib/money';

export type Change = { direction: 'up' | 'down' | 'flat'; text: string };

/**
 * Today against yesterday, as "+12.5%" / "−3.0%" to one decimal (half away
 * from zero), worked out in BigInt. Null when there is nothing to compare
 * against (yesterday was zero or not a number).
 */
export function percentChange(current: string, previous: string): Change | null {
  const now = toSignedPaisa(current);
  const before = toSignedPaisa(previous);
  if (now === null || before === null || before <= 0n) return null;
  // In tenths of a percent.
  const diff = (now - before) * 1000n;
  const negative = diff < 0n;
  const abs = negative ? -diff : diff;
  const tenths = (abs * 2n + before) / (2n * before);
  if (tenths === 0n) return { direction: 'flat', text: '0.0%' };
  const text = `${tenths / 10n}.${tenths % 10n}%`;
  return negative ? { direction: 'down', text: `−${text}` } : { direction: 'up', text: `+${text}` };
}
