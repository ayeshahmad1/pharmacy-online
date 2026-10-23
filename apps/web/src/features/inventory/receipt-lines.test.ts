import { receiveStockBodySchema, type MedicineDto } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { parseForm } from '@/lib/form';
import {
  emptyLine,
  lineDateErrors,
  lineWarnings,
  receiptTotals,
  toReceiptInput,
  tomorrow,
  type ReceiptLine,
} from './receipt-lines';

const today = new Date(2026, 9, 23, 15, 0);

const medicine: MedicineDto = {
  id: '0b9f7f52-2f1b-4d8f-8b7a-6a5c4d3e2f10',
  name: 'Panadol',
  genericName: 'Paracetamol',
  barcode: null,
  category: { id: '7d3b1a0e-8a8f-4c8e-9d0a-1f2e3d4c5b6a', name: 'Analgesics' },
  unit: 'tablet',
  reorderLevel: 50,
  sellingPrice: '2.50',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const line = (over: Partial<ReceiptLine>): ReceiptLine => ({
  ...emptyLine(medicine),
  batchNumber: 'PN-1',
  expiryDate: '2028-01-31',
  costPrice: '1.80',
  quantity: '100',
  ...over,
});

describe('receipt lines', () => {
  it('builds a body the shared schema accepts', () => {
    const input = toReceiptInput('e2a1c3b4-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'INV-9', [
      line({ batchNumber: ' pn-1 ' }),
    ]);
    const parsed = parseForm(receiveStockBodySchema, input);
    expect(parsed).toMatchObject({
      ok: true,
      data: { invoiceNumber: 'INV-9', items: [{ batchNumber: 'PN-1', quantity: 100 }] },
    });
  });

  it('totals units and cost exactly, skipping incomplete lines', () => {
    const totals = receiptTotals([
      line({ costPrice: '0.10', quantity: '3' }),
      line({ costPrice: '19.99', quantity: '1000' }),
      line({ costPrice: '', quantity: '5' }),
      line({ costPrice: '4', quantity: 'abc' }),
    ]);
    expect(totals).toEqual({ units: 1008, cost: 30n + 1999000n });
  });

  it('rejects an expiry of today or earlier', () => {
    const errors = lineDateErrors(
      [line({ expiryDate: '2026-10-23' }), line({ expiryDate: '2026-10-24' })],
      today,
    );
    expect(errors).toEqual({
      'items.0.expiryDate': 'Already expired; expired stock cannot be received',
    });
  });

  it('warns about short expiry and cost above the selling price', () => {
    expect(lineWarnings(line({ expiryDate: '2026-11-10' }), today)).toEqual([
      'Short expiry: only 18 days left',
    ]);
    expect(lineWarnings(line({ costPrice: '3.00' }), today)).toEqual([
      'Cost is above the selling price (Rs 2.50); check the price or the medicine',
    ]);
    expect(lineWarnings(line({}), today)).toEqual([]);
  });

  it('knows tomorrow across a month end', () => {
    expect(tomorrow(new Date(2026, 9, 31))).toBe('2026-11-01');
    expect(tomorrow(new Date(2026, 11, 31))).toBe('2027-01-01');
  });
});
