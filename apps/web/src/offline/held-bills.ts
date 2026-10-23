// Held bills and in-progress carts, kept in IndexedDB on this device. A held
// bill keeps its idempotency key, so resuming and paying it later can never
// save it twice. Nothing here is sent to the server until the bill is paid.

import type { Cart } from '@/features/billing/cart';
import { localDb, STORES } from './db';

export type HeldBill = {
  id: string;
  cart: Cart;
  /** Optional note to find it again, e.g. the customer's name. */
  label: string;
  heldAt: string;
  heldBy: { id: string; fullName: string };
  /** Grand total when held, as an amount string, for the list. */
  total: string;
};

type Draft = { userId: string; cart: Cart; savedAt: string };

export const heldBills = {
  /** Oldest first: the customer who has waited longest is at the top. */
  async list(): Promise<HeldBill[]> {
    const bills = await localDb.getAll<HeldBill>(STORES.heldBills);
    return bills.sort((a, b) => a.heldAt.localeCompare(b.heldAt));
  },
  save: (bill: HeldBill) => localDb.put(STORES.heldBills, bill),
  remove: (id: string) => localDb.delete(STORES.heldBills, id),
};

export const drafts = {
  async get(userId: string): Promise<Cart | null> {
    return (await localDb.get<Draft>(STORES.drafts, userId))?.cart ?? null;
  },
  save: (userId: string, cart: Cart) =>
    localDb.put(STORES.drafts, { userId, cart, savedAt: new Date().toISOString() } satisfies Draft),
  clear: (userId: string) => localDb.delete(STORES.drafts, userId),
};
