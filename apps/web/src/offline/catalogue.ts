// The medicine catalogue kept on this device for selling offline, as pure
// functions (catalogue.test.ts). Stock is worked out the way the API does it:
// the snapshot's batch quantities, minus sales this device made that the
// snapshot doesn't include yet, each taken earliest expiry first from batches
// that hadn't expired on the day it was sold (CLAUDE.md rules 1-3). What is
// sellable is then what sits in batches that haven't expired today.

import type {
  OfflineBatchDto,
  OfflineCatalogueDto,
  OfflineMedicineDto,
  SellableMedicineDto,
  SubstitutesDto,
} from '@pharmacy/shared';

/** The snapshot's details, without the medicines. */
export type CatalogueMeta = Omit<OfflineCatalogueDto, 'medicines'>;

/** Units a sale on this device took from one medicine, not yet in the snapshot. */
export type StockClaim = { medicineId: string; quantity: number; soldAt: string };

/** "YYYY-MM-DD" in the pharmacy's timezone at `at`. */
export function businessDate(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** A batch is expired from its expiry date onward (rule 2). */
const sellableOn = (batch: OfflineBatchDto, day: string) => batch.expiryDate > day;

/**
 * Batch quantities after the claims, per medicine. Claims are applied oldest
 * first, each from batches that were sellable on its day, earliest expiry
 * first. A claim bigger than what is left takes what there is: the units left
 * the shelf whatever the snapshot says.
 */
export function projectBatches(
  medicines: OfflineMedicineDto[],
  claims: StockClaim[],
  timeZone: string,
): Map<string, OfflineBatchDto[]> {
  const batches = new Map(medicines.map((m) => [m.id, m.batches.map((b) => ({ ...b }))]));
  const ordered = [...claims].sort((a, b) => a.soldAt.localeCompare(b.soldAt));
  for (const claim of ordered) {
    const list = batches.get(claim.medicineId);
    if (!list) continue;
    const day = businessDate(new Date(claim.soldAt), timeZone);
    let remaining = claim.quantity;
    for (const batch of list) {
      if (remaining === 0) break;
      if (!sellableOn(batch, day) || batch.quantity <= 0) continue;
      const take = Math.min(batch.quantity, remaining);
      batch.quantity -= take;
      remaining -= take;
    }
  }
  return batches;
}

/** The billing view of a medicine with these batches, today. */
export function toSellable(
  medicine: OfflineMedicineDto,
  batches: OfflineBatchDto[],
  today: string,
  barcodeMatch = false,
): SellableMedicineDto {
  let sellableQuantity = 0;
  let expiredQuantity = 0;
  let nextExpiry: string | null = null;
  for (const b of batches) {
    if (b.quantity <= 0) continue;
    if (sellableOn(b, today)) {
      sellableQuantity += b.quantity;
      if (nextExpiry === null || b.expiryDate < nextExpiry) nextExpiry = b.expiryDate;
    } else {
      expiredQuantity += b.quantity;
    }
  }
  return {
    id: medicine.id,
    name: medicine.name,
    genericName: medicine.genericName,
    barcode: medicine.barcode,
    unit: medicine.unit,
    sellingPrice: medicine.sellingPrice,
    sellableQuantity,
    expiredQuantity,
    isLowStock: sellableQuantity <= medicine.reorderLevel,
    nextExpiry,
    barcodeMatch,
  };
}

const byName = (a: OfflineMedicineDto, b: OfflineMedicineDto) =>
  a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id);

/**
 * The API's billing search, on the cached catalogue: barcode equal to the
 * term, or brand or generic name containing it (case-insensitive). Ranked
 * exact barcode, exact name, name prefix, generic prefix, then the rest.
 */
export function searchCatalogue(
  medicines: OfflineMedicineDto[],
  term: string,
  limit: number,
): { medicine: OfflineMedicineDto; barcodeMatch: boolean }[] {
  const q = term.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const rank = (m: OfflineMedicineDto): number | null => {
    const name = m.name.toLowerCase();
    const generic = m.genericName?.toLowerCase() ?? '';
    if (m.barcode === q) return 0;
    if (name === lower) return 1;
    if (name.startsWith(lower)) return 2;
    if (generic.startsWith(lower)) return 3;
    if (name.includes(lower) || generic.includes(lower)) return 4;
    return null;
  };
  return medicines
    .flatMap((medicine) => {
      const r = rank(medicine);
      return r === null ? [] : [{ medicine, rank: r }];
    })
    .sort((a, b) => a.rank - b.rank || byName(a.medicine, b.medicine))
    .slice(0, limit)
    .map(({ medicine, rank }) => ({ medicine, barcodeMatch: rank === 0 }));
}

/** Most substitutes listed for one medicine; matches the API. */
const MAX_SUBSTITUTES = 20;

/**
 * The API's substitutes on the cached catalogue: other medicines with the
 * same generic name (case-insensitive) that have sellable stock, largest
 * stock first.
 */
export function findSubstitutes(
  medicine: SellableMedicineDto,
  candidates: SellableMedicineDto[],
): SubstitutesDto {
  const generic = medicine.genericName?.toLowerCase();
  if (!generic) return { medicine, substitutes: [] };
  const substitutes = candidates
    .filter(
      (m) =>
        m.id !== medicine.id && m.genericName?.toLowerCase() === generic && m.sellableQuantity > 0,
    )
    .sort(
      (a, b) =>
        b.sellableQuantity - a.sellableQuantity ||
        a.name.localeCompare(b.name, 'en') ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_SUBSTITUTES);
  return { medicine, substitutes };
}

/**
 * The batches FEFO would sell `quantity` from today, or null if there isn't
 * enough sellable stock. Only a prediction: the API allocates for real at
 * sync. Used for the provisional receipt.
 */
export function predictFefo(
  batches: OfflineBatchDto[],
  quantity: number,
  today: string,
): { batch: OfflineBatchDto; quantity: number }[] | null {
  const out: { batch: OfflineBatchDto; quantity: number }[] = [];
  let remaining = quantity;
  for (const batch of batches) {
    if (remaining === 0) break;
    if (!sellableOn(batch, today) || batch.quantity <= 0) continue;
    const take = Math.min(batch.quantity, remaining);
    out.push({ batch, quantity: take });
    remaining -= take;
  }
  return remaining === 0 ? out : null;
}
