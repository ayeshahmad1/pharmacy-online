import type { OfflineMedicineDto } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { medicine as sellable } from '@/features/billing/test-fixtures';
import {
  businessDate,
  findSubstitutes,
  predictFefo,
  projectBatches,
  searchCatalogue,
  toSellable,
} from './catalogue';

const TZ = 'Asia/Karachi';
let seq = 0;

function med(overrides: Partial<OfflineMedicineDto> = {}): OfflineMedicineDto {
  seq += 1;
  return {
    id: `m-${String(seq).padStart(3, '0')}`,
    name: `Medicine ${seq}`,
    genericName: null,
    barcode: null,
    unit: 'tablet',
    sellingPrice: '10.00',
    reorderLevel: 5,
    batches: [],
    ...overrides,
  };
}

const batch = (id: string, expiryDate: string, quantity: number) => ({
  id,
  batchNumber: id.toUpperCase(),
  expiryDate,
  quantity,
});

describe('businessDate', () => {
  it('uses the pharmacy’s day, not UTC’s', () => {
    // 20:30 UTC on the 23rd is 01:30 on the 24th in Karachi (UTC+5).
    expect(businessDate(new Date('2026-10-23T20:30:00Z'), TZ)).toBe('2026-10-24');
    expect(businessDate(new Date('2026-10-23T18:59:59Z'), TZ)).toBe('2026-10-23');
  });
});

describe('projectBatches', () => {
  const m = med({
    batches: [
      batch('a', '2026-10-25', 3),
      batch('b', '2026-12-01', 10),
      batch('c', '2027-06-01', 10),
    ],
  });
  const at = (date: string) => `${date}T07:00:00.000Z`; // noon in Karachi

  it('takes queued sales earliest expiry first, spanning batches', () => {
    const projected = projectBatches(
      [m],
      [{ medicineId: m.id, quantity: 5, soldAt: at('2026-10-24') }],
      TZ,
    );
    expect(projected.get(m.id)!.map((b) => b.quantity)).toEqual([0, 8, 10]);
    // The snapshot itself is left alone.
    expect(m.batches.map((b) => b.quantity)).toEqual([3, 10, 10]);
  });

  it('skips batches that had expired on the day of each sale', () => {
    // Batch a is expired from the 25th onward.
    const projected = projectBatches(
      [m],
      [
        { medicineId: m.id, quantity: 2, soldAt: at('2026-10-25') },
        { medicineId: m.id, quantity: 1, soldAt: at('2026-10-24') },
      ],
      TZ,
    );
    // The sale on the 24th took from a; the one on the 25th could not.
    expect(projected.get(m.id)!.map((b) => b.quantity)).toEqual([2, 8, 10]);
  });

  it('applies sales oldest first whatever order they are queued in', () => {
    const projected = projectBatches(
      [m],
      [
        { medicineId: m.id, quantity: 2, soldAt: at('2026-10-25') },
        { medicineId: m.id, quantity: 3, soldAt: at('2026-10-24') },
      ],
      TZ,
    );
    expect(projected.get(m.id)!.map((b) => b.quantity)).toEqual([0, 8, 10]);
  });

  it('drains what is left when a sale took more than the snapshot holds', () => {
    const projected = projectBatches(
      [m],
      [{ medicineId: m.id, quantity: 50, soldAt: at('2026-10-24') }],
      TZ,
    );
    expect(projected.get(m.id)!.map((b) => b.quantity)).toEqual([0, 0, 0]);
  });

  it('ignores medicines that are not in the catalogue', () => {
    const projected = projectBatches(
      [m],
      [{ medicineId: 'gone', quantity: 1, soldAt: at('2026-10-24') }],
      TZ,
    );
    expect(projected.get(m.id)!.map((b) => b.quantity)).toEqual([3, 10, 10]);
    expect(projected.has('gone')).toBe(false);
  });
});

describe('toSellable', () => {
  it('splits stock into sellable and expired as of today', () => {
    const m = med({ reorderLevel: 12 });
    const view = toSellable(
      m,
      [batch('old', '2026-10-24', 4), batch('a', '2026-11-01', 0), batch('b', '2026-12-01', 10)],
      '2026-10-24',
    );
    expect(view).toMatchObject({
      id: m.id,
      sellingPrice: '10.00',
      sellableQuantity: 10,
      expiredQuantity: 4,
      // The empty batch is not what FEFO sells next.
      nextExpiry: '2026-12-01',
      isLowStock: true,
      barcodeMatch: false,
    });
  });

  it('reports nothing sellable when every batch is empty or expired', () => {
    const view = toSellable(med(), [batch('old', '2026-01-01', 2)], '2026-10-24');
    expect(view).toMatchObject({ sellableQuantity: 0, expiredQuantity: 2, nextExpiry: null });
  });
});

describe('searchCatalogue', () => {
  const panadol = med({
    name: 'Panadol 500mg',
    genericName: 'Paracetamol',
    barcode: '8964000123457',
  });
  const panadolCf = med({ name: 'Panadol CF', genericName: 'Paracetamol + Caffeine' });
  const calpol = med({ name: 'Calpol Syrup', genericName: 'Paracetamol' });
  const exact = med({ name: 'Pana', genericName: null });
  const brufen = med({ name: 'Brufen 400mg', genericName: 'Ibuprofen', barcode: 'PANA' });
  const all = [brufen, calpol, panadolCf, panadol, exact];
  const names = (term: string, limit = 10) =>
    searchCatalogue(all, term, limit).map((r) => r.medicine.name);

  it('ranks barcode, exact name, name prefix, generic prefix, then contains', () => {
    expect(names('pana')).toEqual(['Pana', 'Panadol 500mg', 'Panadol CF']);
    expect(names('PANA')).toEqual(['Brufen 400mg', 'Pana', 'Panadol 500mg', 'Panadol CF']);
    expect(names('para')).toEqual(['Calpol Syrup', 'Panadol 500mg', 'Panadol CF']);
    expect(names('caff')).toEqual(['Panadol CF']);
  });

  it('flags only an exact barcode match', () => {
    const [hit] = searchCatalogue(all, '8964000123457', 10);
    expect(hit).toEqual({ medicine: panadol, barcodeMatch: true });
    expect(searchCatalogue(all, '896400012345', 10)).toEqual([]);
  });

  it('honours the limit and ignores blank terms', () => {
    expect(names('a', 2)).toHaveLength(2);
    expect(names('   ')).toEqual([]);
  });
});

describe('findSubstitutes', () => {
  it('lists in-stock medicines with the same salt, largest stock first', () => {
    const asked = sellable({ name: 'Panadol', genericName: 'Paracetamol', sellableQuantity: 0 });
    const big = sellable({ name: 'Calpol', genericName: 'paracetamol', sellableQuantity: 50 });
    const small = sellable({ name: 'Tylenol', genericName: 'PARACETAMOL', sellableQuantity: 5 });
    const empty = sellable({ name: 'Disprol', genericName: 'Paracetamol', sellableQuantity: 0 });
    const other = sellable({ name: 'Brufen', genericName: 'Ibuprofen', sellableQuantity: 99 });

    const result = findSubstitutes(asked, [asked, small, empty, other, big]);
    expect(result.medicine).toBe(asked);
    expect(result.substitutes.map((m) => m.name)).toEqual(['Calpol', 'Tylenol']);
  });

  it('has none for a medicine without a generic name', () => {
    const asked = sellable({ genericName: null });
    expect(findSubstitutes(asked, [sellable({ genericName: null })]).substitutes).toEqual([]);
  });
});

describe('predictFefo', () => {
  const batches = [
    batch('x', '2026-10-24', 5),
    batch('a', '2026-11-01', 2),
    batch('b', '2027-01-01', 9),
  ];

  it('picks unexpired batches earliest expiry first', () => {
    expect(predictFefo(batches, 4, '2026-10-24')).toEqual([
      { batch: batches[1], quantity: 2 },
      { batch: batches[2], quantity: 2 },
    ]);
  });

  it('returns null when there is not enough sellable stock', () => {
    expect(predictFefo(batches, 12, '2026-10-24')).toBeNull();
  });
});
