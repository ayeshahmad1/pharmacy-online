import type { SellableMedicineDto } from '@pharmacy/shared';

let seq = 0;

/** A sellable medicine with a unique id; override what the test cares about. */
export function medicine(overrides: Partial<SellableMedicineDto> = {}): SellableMedicineDto {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `Medicine ${seq}`,
    genericName: null,
    barcode: null,
    unit: 'tablet',
    sellingPrice: '10.00',
    sellableQuantity: 100,
    expiredQuantity: 0,
    isLowStock: false,
    nextExpiry: '2027-06-30',
    barcodeMatch: false,
    ...overrides,
  };
}
