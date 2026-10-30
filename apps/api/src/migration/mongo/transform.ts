// Pure mapping from the legacy MongoDB documents to rows of our schema. No
// I/O: migrate.ts reads Mongo, calls these, and writes Postgres. Legacy money
// is a JS float; it is converted to BigInt paisa once, here (CLAUDE.md rule
// 6), and everything after that is exact.
//
// A document that can't be mapped throws `Rejected` with a reason code; the
// runner logs it to rejects.jsonl. Things worth a look that don't stop a
// document (rounded prices, unknown cost) go to the `warn` callback.

import { RoleCode } from '@prisma/client';
import { businessToday, toDateOnly, addDays } from '../../lib/dates';
import { allocate, formatPaisa, sumPaisa, type Paisa } from '../../lib/money';

// ─── Legacy document shapes (ObjectIds already turned into hex strings) ─────

export type LegacyUser = {
  id: string;
  name?: unknown;
  email?: unknown;
  password?: unknown;
  role?: unknown;
};

/** The old system kept one document per medicine *and* batch. */
export type LegacyMedicine = {
  id: string;
  /** When the ObjectId was generated; used when createdAt is missing. */
  idTime: Date;
  name?: unknown;
  type?: unknown;
  batchNo?: unknown;
  expiryDate?: unknown;
  quantity?: unknown;
  price?: unknown;
  supplier?: unknown;
  isActive?: unknown;
  createdAt?: unknown;
};

export type LegacyPurchase = {
  id: string;
  medicineId: string | null;
  quantity?: unknown;
  /** Total paid for the whole delivery, not per unit. 0 when not entered. */
  purchasePrice?: unknown;
  purchaseDate?: unknown;
};

export type LegacySaleItem = {
  medicineId: string | null;
  quantity?: unknown;
  /** Older sales: unit price. */
  price?: unknown;
  /** Newer sales: unit price before discount (`discountedPrice` is derived, not used). */
  originalPrice?: unknown;
};

export type LegacySale = {
  id: string;
  items: LegacySaleItem[];
  /** What the customer paid. Negative for returns. */
  totalPrice?: unknown;
  /** Newer sales only: the bill discount the old system recorded. */
  totalDiscount?: unknown;
  billNumber?: unknown;
  isReturn?: unknown;
  isManualReturn?: unknown;
  cashierId: string | null;
  createdAt?: unknown;
};

// ─── Rejections ─────────────────────────────────────────────────────────────

export type RejectReason =
  | 'USER_BAD_ROLE'
  | 'USER_BAD_PASSWORD_HASH'
  | 'MEDICINE_EMPTY_NAME'
  | 'MEDICINE_BAD_PRICE'
  | 'MEDICINE_BAD_QUANTITY'
  | 'MEDICINE_BAD_EXPIRY_DATE'
  | 'PURCHASE_MEDICINE_MISSING'
  | 'SALE_IS_LEGACY_RETURN'
  | 'SALE_BAD_DATE'
  | 'SALE_NO_ITEMS'
  | 'SALE_BAD_QUANTITY'
  | 'SALE_BAD_PRICE'
  | 'SALE_BAD_TOTAL'
  | 'SALE_TOTAL_ABOVE_SUBTOTAL'
  | 'SALE_ZERO_TOTAL'
  | 'SALE_MEDICINE_REJECTED'
  | 'SALE_CASHIER_REJECTED';

export class Rejected extends Error {
  constructor(
    readonly reason: RejectReason,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

export type Warn = (code: string, detail: string) => void;

// ─── Values ─────────────────────────────────────────────────────────────────

/** Decimal(12,2) holds less than this. */
const MAX_AMOUNT = 1e10;

/**
 * A legacy float amount in paisa, rounded half-up to 2 decimals, or null if
 * it isn't a non-negative number. `rounded` is true when the value really had
 * more than 2 decimals (e.g. 13.335), not for float noise such as
 * 350.79999999999995, which is 350.80.
 */
export function legacyMoney(value: unknown): { paisa: Paisa; rounded: boolean } | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_AMOUNT) {
    return null;
  }
  // toFixed(9) rounds the exact binary value to 9 decimals, which removes
  // float noise; then round half-up at the 2nd decimal using the digits.
  const [whole, fraction] = value.toFixed(9).split('.') as [string, string];
  const rest = fraction.slice(2);
  let paisa = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2));
  if (rest >= '5000000') paisa += 1n;
  return { paisa, rounded: /[1-9]/.test(rest) };
}

/** A whole number of units: positive, or also 0 when `allowZero`. */
export function legacyCount(value: unknown, allowZero = false): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1)
    ? value
    : null;
}

const validDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

/**
 * Expiry as "YYYY-MM-DD". The old system stored dates at UTC midnight; any
 * other time is read as a moment and converted to the pharmacy's day. Years
 * outside 2000–2100 are typos (one document has year 0027).
 */
export function legacyExpiryDate(value: unknown, timeZone: string): string | null {
  if (!validDate(value)) return null;
  const year = value.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  const atUtcMidnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;
  return atUtcMidnight ? toDateOnly(value) : businessToday(value, timeZone);
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

/** Last 6 hex digits of an ObjectId, for placeholder names. */
export const shortId = (legacyId: string) => legacyId.slice(-6);

// ─── Users ──────────────────────────────────────────────────────────────────

const LEGACY_ROLES: Record<string, RoleCode> = {
  admin: RoleCode.ADMIN,
  pharmacist: RoleCode.PHARMACIST,
  cashier: RoleCode.CASHIER,
};

/** bcrypt hashes from either library the old system may have used ($2a$/$2b$). */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export type MappedUser = {
  /** Wanted username; the runner makes it unique. */
  username: string;
  fullName: string;
  email: string | null;
  passwordHash: string;
  role: RoleCode;
};

/**
 * Staff keep their passwords: the old hashes are bcrypt, which our login
 * checks. They log in with the part of their email before the "@".
 */
export function mapUser(doc: LegacyUser): MappedUser {
  const role = LEGACY_ROLES[text(doc.role).toLowerCase()];
  if (!role) throw new Rejected('USER_BAD_ROLE', `role "${String(doc.role)}"`);
  if (typeof doc.password !== 'string' || !BCRYPT_HASH.test(doc.password)) {
    throw new Rejected('USER_BAD_PASSWORD_HASH', 'password is not a bcrypt hash');
  }
  const email = text(doc.email).toLowerCase() || null;
  const fullName = text(doc.name) || email || `Legacy user ${shortId(doc.id)}`;
  const base = (email?.split('@')[0] ?? fullName).toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  return {
    username: (base || `user-${shortId(doc.id)}`).slice(0, 60),
    fullName,
    email,
    passwordHash: doc.password,
    role,
  };
}

/** `wanted`, or `wanted-2`, `wanted-3`… whichever isn't in `taken` yet. Adds it to `taken`. */
export function uniqueName(wanted: string, taken: Set<string>): string {
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}-${n}`;
  taken.add(name.toLowerCase());
  return name;
}

// ─── Suppliers ──────────────────────────────────────────────────────────────

export const UNKNOWN_SUPPLIER = 'Unknown supplier';

/** Blank, digits only ("0", "00", "800"), or a word that isn't a supplier. */
const JUNK_SUPPLIER = /^(?:[\d\s.-]*|return|discount)$/i;

/** Trimmed supplier name, or UNKNOWN_SUPPLIER for placeholders like "00". */
export function supplierName(raw: unknown): string {
  const name = text(raw);
  return JUNK_SUPPLIER.test(name) ? UNKNOWN_SUPPLIER : name;
}

/** Suppliers differing only in letter case are the same supplier. */
export const supplierKey = (name: string) => name.toLowerCase();

// ─── Medicines (and their single batch) ─────────────────────────────────────

export type MappedMedicine = {
  name: string;
  unit: string;
  sellingPrice: Paisa;
  active: boolean;
  supplier: string;
  batchNumber: string;
  expiryDate: string;
  /** Stock on hand in Mongo, loaded as the opening balance. */
  openingQuantity: number;
  createdAt: Date;
};

export function mapMedicine(doc: LegacyMedicine, timeZone: string, warn: Warn): MappedMedicine {
  const name = text(doc.name);
  if (!name) throw new Rejected('MEDICINE_EMPTY_NAME');

  const price = legacyMoney(doc.price);
  if (!price) throw new Rejected('MEDICINE_BAD_PRICE', `price ${String(doc.price)}`);
  if (price.rounded) {
    warn('PRICE_ROUNDED', `price ${String(doc.price)} → ${formatPaisa(price.paisa)}`);
  }

  const openingQuantity = legacyCount(doc.quantity, true);
  if (openingQuantity === null) {
    throw new Rejected('MEDICINE_BAD_QUANTITY', `quantity ${String(doc.quantity)}`);
  }

  const expiryDate = legacyExpiryDate(doc.expiryDate, timeZone);
  if (!expiryDate) {
    const shown = validDate(doc.expiryDate) ? doc.expiryDate.toISOString() : String(doc.expiryDate);
    throw new Rejected('MEDICINE_BAD_EXPIRY_DATE', `expiryDate ${shown}`);
  }

  return {
    name,
    unit: text(doc.type).toLowerCase() || 'unit',
    sellingPrice: price.paisa,
    active: doc.isActive !== false,
    supplier: supplierName(doc.supplier),
    batchNumber: text(doc.batchNo) || 'LEGACY',
    expiryDate,
    openingQuantity,
    createdAt: validDate(doc.createdAt) ? doc.createdAt : doc.idTime,
  };
}

/**
 * Cost per unit from the latest purchase that has a price: the delivery's
 * total ÷ its quantity, rounded half-up. Null when no purchase has a price
 * (most were entered with 0).
 */
export function unitCostFromPurchases(purchases: LegacyPurchase[]): Paisa | null {
  let latest: { at: number; total: Paisa; quantity: number } | null = null;
  for (const p of purchases) {
    const total = legacyMoney(p.purchasePrice);
    const quantity = legacyCount(p.quantity);
    if (!total || total.paisa === 0n || quantity === null || !validDate(p.purchaseDate)) continue;
    const at = p.purchaseDate.getTime();
    if (!latest || at >= latest.at) latest = { at, total: total.paisa, quantity };
  }
  if (!latest) return null;
  const q = BigInt(latest.quantity);
  return (2n * latest.total + q) / (2n * q);
}

/**
 * Batch.quantityReceived is informational and must be positive. Use the
 * largest figure we know arrived: recorded purchases, what's on the shelf,
 * or what was sold. 0 means nothing ever arrived, so no batch is created.
 */
export const quantityReceived = (purchased: number, onHand: number, sold: number) =>
  Math.max(purchased, onHand, sold);

/** Placeholder batches for deleted medicines expire the day after their last sale. */
export const placeholderExpiry = (lastSoldDay: string) => addDays(lastSoldDay, 1);

// ─── Sales ──────────────────────────────────────────────────────────────────

export type MappedSaleLine = {
  medicineLegacyId: string;
  quantity: number;
  unitPrice: Paisa;
  discount: Paisa;
  lineTotal: Paisa;
};

export type MappedSale = {
  soldAt: Date;
  subtotal: Paisa;
  discountTotal: Paisa;
  grandTotal: Paisa;
  lines: MappedSaleLine[];
  notes: string;
};

const isLegacyReturn = (doc: LegacySale) =>
  doc.isReturn === true ||
  doc.isManualReturn === true ||
  (typeof doc.totalPrice === 'number' && doc.totalPrice < 0);

/**
 * One legacy sale. Prices come from the sale, not today's catalogue. The old
 * system didn't record bill discounts on older sales, only a total below the
 * sum of the lines; the difference is the bill discount, spread over the lines
 * by value the same way our sales engine does, so every line is exact and
 * lines add up to the total paid.
 */
export function mapSale(doc: LegacySale, warn: Warn): MappedSale {
  if (isLegacyReturn(doc)) {
    throw new Rejected('SALE_IS_LEGACY_RETURN', `total ${String(doc.totalPrice)}`);
  }
  if (!validDate(doc.createdAt)) throw new Rejected('SALE_BAD_DATE');
  if (doc.items.length === 0) throw new Rejected('SALE_NO_ITEMS');

  const lines = doc.items.map((item, index) => {
    const quantity = legacyCount(item.quantity);
    if (quantity === null || !item.medicineId) {
      throw new Rejected('SALE_BAD_QUANTITY', `line ${index + 1}: ${String(item.quantity)}`);
    }
    const rawPrice = item.originalPrice ?? item.price;
    const price = legacyMoney(rawPrice);
    if (!price) throw new Rejected('SALE_BAD_PRICE', `line ${index + 1}: ${String(rawPrice)}`);
    if (price.rounded) {
      warn('PRICE_ROUNDED', `line ${index + 1}: ${String(rawPrice)} → ${formatPaisa(price.paisa)}`);
    }
    return { medicineLegacyId: item.medicineId, quantity, unitPrice: price.paisa };
  });

  const total = legacyMoney(doc.totalPrice);
  if (!total) throw new Rejected('SALE_BAD_TOTAL', `total ${String(doc.totalPrice)}`);
  const values = lines.map((l) => BigInt(l.quantity) * l.unitPrice);
  const subtotal = sumPaisa(values);
  if (total.paisa > subtotal) {
    throw new Rejected(
      'SALE_TOTAL_ABOVE_SUBTOTAL',
      `total ${formatPaisa(total.paisa)} > lines ${formatPaisa(subtotal)}`,
    );
  }
  if (total.paisa === 0n) throw new Rejected('SALE_ZERO_TOTAL');

  const discountTotal = subtotal - total.paisa;
  const recorded = legacyMoney(doc.totalDiscount);
  if (recorded && recorded.paisa !== discountTotal) {
    warn(
      'DISCOUNT_DIFFERS',
      `recorded ${formatPaisa(recorded.paisa)}, lines − total = ${formatPaisa(discountTotal)}`,
    );
  }
  const discounts = allocate(discountTotal, values);
  const billNumber = text(doc.billNumber);

  return {
    soldAt: doc.createdAt,
    subtotal,
    discountTotal,
    grandTotal: total.paisa,
    lines: lines.map((l, i) => ({
      ...l,
      discount: discounts[i]!,
      lineTotal: values[i]! - discounts[i]!,
    })),
    notes: billNumber
      ? `Migrated from the old system, bill ${billNumber}`
      : 'Migrated from the old system (no bill number)',
  };
}

/**
 * Receipt numbers S-YYYYMMDD-NNNN for migrated sales, in time order within
 * each business day, so they are gap-free like the ones the app issues.
 * Returns each sale's number and the last number per day (for ReceiptCounter,
 * so the first new sale of a migrated day continues the series).
 */
export function assignReceiptNumbers(
  sales: { key: string; soldAt: Date }[],
  timeZone: string,
): { numbers: Map<string, string>; lastPerDay: Map<string, number> } {
  const ordered = [...sales].sort(
    (a, b) => a.soldAt.getTime() - b.soldAt.getTime() || a.key.localeCompare(b.key),
  );
  const numbers = new Map<string, string>();
  const lastPerDay = new Map<string, number>();
  for (const sale of ordered) {
    const day = businessToday(sale.soldAt, timeZone);
    const n = (lastPerDay.get(day) ?? 0) + 1;
    lastPerDay.set(day, n);
    numbers.set(sale.key, `S-${day.replace(/-/g, '')}-${String(n).padStart(4, '0')}`);
  }
  return { numbers, lastPerDay };
}
