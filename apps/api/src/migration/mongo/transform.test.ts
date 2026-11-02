import { describe, expect, it, vi } from 'vitest';
import { formatPaisa } from '../../lib/money';
import {
  Rejected,
  UNKNOWN_SUPPLIER,
  assignReceiptNumbers,
  isLegacyReturn,
  legacyExpiryDate,
  legacyMoney,
  mapLegacyReturn,
  mapMedicine,
  mapPurchase,
  mapSale,
  mapUser,
  quantityReceived,
  supplierName,
  uniqueName,
  unitCostFromPurchases,
  type LegacyMedicine,
  type LegacyPurchase,
  type LegacySale,
} from './transform';

const TZ = 'Asia/Karachi';
const HASH = '$2b$10$' + 'a'.repeat(53);

function rejection(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Rejected) return e.reason;
    throw e;
  }
  throw new Error('expected a rejection');
}

describe('legacyMoney', () => {
  it('drops float noise without flagging it', () => {
    expect(legacyMoney(350.79999999999995)).toEqual({ paisa: 35080n, rounded: false });
    expect(legacyMoney(19.23)).toEqual({ paisa: 1923n, rounded: false });
    expect(legacyMoney(3800)).toEqual({ paisa: 380000n, rounded: false });
  });

  it('rounds real extra decimals half-up and flags them', () => {
    expect(legacyMoney(13.335)).toEqual({ paisa: 1334n, rounded: true });
    expect(legacyMoney(1.005)).toEqual({ paisa: 101n, rounded: true });
    expect(legacyMoney(2480.844)).toEqual({ paisa: 248084n, rounded: true });
  });

  it('refuses negatives, non-numbers and amounts too big for Decimal(12,2)', () => {
    for (const v of [-1, NaN, Infinity, '12', null, undefined, 1e10])
      expect(legacyMoney(v)).toBeNull();
  });
});

describe('legacyExpiryDate', () => {
  it('keeps UTC-midnight dates as they are', () => {
    expect(legacyExpiryDate(new Date('2030-03-31T00:00:00Z'), TZ)).toBe('2030-03-31');
  });

  it('reads other times as a moment in the pharmacy timezone', () => {
    // 19:00 UTC on Dec 31 is already Jan 1 in Karachi.
    expect(legacyExpiryDate(new Date('2026-12-31T19:00:00Z'), TZ)).toBe('2027-01-01');
  });

  it('refuses typo years and non-dates', () => {
    expect(legacyExpiryDate(new Date(-61292505600000), TZ)).toBeNull();
    expect(legacyExpiryDate('2030-01-01', TZ)).toBeNull();
  });
});

describe('mapUser', () => {
  it('keeps the bcrypt hash and logs in by the email name', () => {
    expect(
      mapUser({
        id: 'u1',
        name: 'Yasir',
        email: ' Yasir@Gmail.com ',
        password: HASH,
        role: 'cashier',
      }),
    ).toEqual({
      username: 'yasir',
      fullName: 'Yasir',
      email: 'yasir@gmail.com',
      passwordHash: HASH,
      role: 'CASHIER',
    });
  });

  it('rejects unknown roles and non-bcrypt passwords', () => {
    expect(
      rejection(() => mapUser({ id: 'u', email: 'a@b.c', password: HASH, role: 'owner' })),
    ).toBe('USER_BAD_ROLE');
    expect(
      rejection(() => mapUser({ id: 'u', email: 'a@b.c', password: 'secret', role: 'admin' })),
    ).toBe('USER_BAD_PASSWORD_HASH');
  });

  it('makes names unique case-insensitively', () => {
    const taken = new Set(['admin']);
    expect(uniqueName('Admin', taken)).toBe('Admin-2');
    expect(uniqueName('admin', taken)).toBe('admin-3');
    expect(uniqueName('yasir', taken)).toBe('yasir');
  });
});

describe('supplierName', () => {
  it('trims and collapses spaces', () => {
    expect(supplierName('  AL   Murtaza ')).toBe('AL Murtaza');
  });

  it('turns placeholders into the unknown supplier', () => {
    for (const v of ['00', '0', '800', '', '  Return', 'Discount', undefined]) {
      expect(supplierName(v)).toBe(UNKNOWN_SUPPLIER);
    }
  });
});

describe('mapMedicine', () => {
  const base: LegacyMedicine = {
    id: 'm1',
    idTime: new Date('2025-07-25T00:00:00Z'),
    name: ' Myfol ',
    type: 'tablet',
    batchNo: '1',
    expiryDate: new Date('2028-01-01T00:00:00Z'),
    quantity: 32,
    price: 19.23,
    supplier: 'RG Pharma',
    isActive: true,
  };

  it('maps one document to a medicine with one batch of opening stock', () => {
    const warn = vi.fn();
    expect(mapMedicine(base, TZ, warn)).toEqual({
      name: 'Myfol',
      unit: 'tablet',
      sellingPrice: 1923n,
      active: true,
      supplier: 'RG Pharma',
      batchNumber: '1',
      expiryDate: '2028-01-01',
      openingQuantity: 32,
      createdAt: base.idTime,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the price had to be rounded', () => {
    const warn = vi.fn();
    expect(mapMedicine({ ...base, price: 41.255 }, TZ, warn).sellingPrice).toBe(4126n);
    expect(warn).toHaveBeenCalledWith('PRICE_ROUNDED', expect.any(String));
  });

  it('rejects bad expiry dates, quantities and prices', () => {
    const warn = vi.fn();
    expect(
      rejection(() => mapMedicine({ ...base, expiryDate: new Date(-61292505600000) }, TZ, warn)),
    ).toBe('MEDICINE_BAD_EXPIRY_DATE');
    expect(rejection(() => mapMedicine({ ...base, quantity: -1 }, TZ, warn))).toBe(
      'MEDICINE_BAD_QUANTITY',
    );
    expect(rejection(() => mapMedicine({ ...base, quantity: 1.5 }, TZ, warn))).toBe(
      'MEDICINE_BAD_QUANTITY',
    );
    expect(rejection(() => mapMedicine({ ...base, price: -5 }, TZ, warn))).toBe(
      'MEDICINE_BAD_PRICE',
    );
    expect(rejection(() => mapMedicine({ ...base, name: '  ' }, TZ, warn))).toBe(
      'MEDICINE_EMPTY_NAME',
    );
  });
});

describe('unitCostFromPurchases', () => {
  const at = (d: string) => new Date(d);

  it('divides the latest priced delivery by its quantity, half-up', () => {
    expect(
      unitCostFromPurchases([
        {
          id: 'a',
          medicineId: 'm',
          quantity: 100,
          purchasePrice: 2800,
          purchaseDate: at('2026-01-01'),
        },
        {
          id: 'b',
          medicineId: 'm',
          quantity: 300,
          purchasePrice: 3550,
          purchaseDate: at('2026-05-01'),
        },
        {
          id: 'c',
          medicineId: 'm',
          quantity: 40,
          purchasePrice: 0,
          purchaseDate: at('2026-09-01'),
        },
      ]),
    ).toBe(1183n); // 3550 / 300 = 11.8333…
  });

  it('is null when no purchase has a price', () => {
    expect(
      unitCostFromPurchases([
        {
          id: 'a',
          medicineId: 'm',
          quantity: 10,
          purchasePrice: 0,
          purchaseDate: at('2026-01-01'),
        },
      ]),
    ).toBeNull();
    expect(unitCostFromPurchases([])).toBeNull();
  });
});

describe('quantityReceived', () => {
  it('takes the largest of purchased, on hand, sold and returned', () => {
    expect(quantityReceived(400, 654, 2305)).toBe(2305);
    expect(quantityReceived(0, 0, 0, 3)).toBe(3);
    expect(quantityReceived(0, 0, 0)).toBe(0);
  });
});

describe('mapPurchase', () => {
  const purchase = (over: Partial<LegacyPurchase>): LegacyPurchase => ({
    id: 'p1',
    medicineId: 'm1',
    quantity: 300,
    purchasePrice: 3550,
    purchaseDate: new Date('2026-05-01T10:00:00Z'),
    supplier: ' AL Qamar ',
    discount: 0,
    ...over,
  });

  it('keeps the delivery as history with its supplier and total', () => {
    const warn = vi.fn();
    const mapped = mapPurchase(purchase({}), warn);
    expect(mapped).toMatchObject({
      medicineLegacyId: 'm1',
      quantity: 300,
      purchasedAt: new Date('2026-05-01T10:00:00Z'),
      supplier: 'AL Qamar',
    });
    expect(formatPaisa(mapped.totalCost!)).toBe('3550.00');
    expect(warn).not.toHaveBeenCalled();
  });

  it('has no cost when the price was left at 0, and an unknown supplier for "00"', () => {
    expect(mapPurchase(purchase({ purchasePrice: 0, supplier: '00' }), vi.fn())).toMatchObject({
      totalCost: null,
      supplier: UNKNOWN_SUPPLIER,
    });
  });

  it('reports a discount it does not apply', () => {
    const warn = vi.fn();
    mapPurchase(purchase({ discount: 50 }), warn);
    expect(warn).toHaveBeenCalledWith('PURCHASE_DISCOUNT_IGNORED', 'discount 50');
  });

  it('rejects missing medicines, bad quantities, prices and dates', () => {
    const r = (over: Partial<LegacyPurchase>) =>
      rejection(() => mapPurchase(purchase(over), vi.fn()));
    expect(r({ medicineId: null })).toBe('PURCHASE_MEDICINE_MISSING');
    expect(r({ quantity: 0 })).toBe('PURCHASE_BAD_QUANTITY');
    expect(r({ quantity: 2.5 })).toBe('PURCHASE_BAD_QUANTITY');
    expect(r({ purchasePrice: -1 })).toBe('PURCHASE_BAD_PRICE');
    expect(r({ purchaseDate: 'last week' })).toBe('PURCHASE_BAD_DATE');
  });
});

describe('mapLegacyReturn', () => {
  const ret = (over: Partial<LegacySale>): LegacySale => ({
    id: 'r1',
    cashierId: 'u1',
    createdAt: new Date('2026-04-07T15:03:56Z'),
    isReturn: true,
    isManualReturn: true,
    items: [
      { medicineId: 'a', quantity: 13, originalPrice: 455 },
      { medicineId: 'b', quantity: 4, originalPrice: 306 },
    ],
    totalPrice: -7139,
    ...over,
  });

  it('recognises returns by their flags or a negative total', () => {
    expect(isLegacyReturn(ret({}))).toBe(true);
    expect(isLegacyReturn(ret({ isReturn: false, isManualReturn: false }))).toBe(true);
    expect(isLegacyReturn(ret({ isReturn: false, isManualReturn: false, totalPrice: 10 }))).toBe(
      false,
    );
  });

  it('keeps the lines at full value when they add up to the refund', () => {
    const warn = vi.fn();
    const mapped = mapLegacyReturn(ret({}), warn);
    expect(formatPaisa(mapped.refundTotal)).toBe('7139.00');
    expect(mapped.returnedAt).toEqual(new Date('2026-04-07T15:03:56Z'));
    expect(
      mapped.lines.map((l) => [l.medicineLegacyId, l.quantity, formatPaisa(l.lineTotal)]),
    ).toEqual([
      ['a', 13, '5915.00'],
      ['b', 4, '1224.00'],
    ]);
    expect(mapped.lines.every((l) => l.discount === 0n)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('spreads a refund below the lines over them by value', () => {
    const mapped = mapLegacyReturn(
      ret({
        items: [
          { medicineId: 'a', quantity: 1, price: 100 },
          { medicineId: 'b', quantity: 2, price: 150 },
        ],
        totalPrice: -360,
      }),
      vi.fn(),
    );
    expect(mapped.lines.map((l) => formatPaisa(l.discount))).toEqual(['10.00', '30.00']);
    expect(mapped.lines.map((l) => formatPaisa(l.lineTotal))).toEqual(['90.00', '270.00']);
  });

  it('keeps full lines and warns when the refund is above them', () => {
    const warn = vi.fn();
    const mapped = mapLegacyReturn(ret({ totalPrice: -7200 }), warn);
    expect(formatPaisa(mapped.refundTotal)).toBe('7200.00');
    expect(mapped.lines.every((l) => l.discount === 0n)).toBe(true);
    expect(warn).toHaveBeenCalledWith('RETURN_TOTAL_ABOVE_LINES', expect.any(String));
  });

  it('rejects bad dates, lines and totals', () => {
    const item = { medicineId: 'a', quantity: 1, price: 100 };
    const r = (over: Partial<LegacySale>) => rejection(() => mapLegacyReturn(ret(over), vi.fn()));
    expect(r({ createdAt: 'yesterday' })).toBe('RETURN_BAD_DATE');
    expect(r({ items: [] })).toBe('RETURN_NO_ITEMS');
    expect(r({ items: [{ ...item, quantity: 0 }] })).toBe('RETURN_BAD_QUANTITY');
    expect(r({ items: [{ ...item, medicineId: null }] })).toBe('RETURN_BAD_QUANTITY');
    expect(r({ items: [{ ...item, price: undefined }] })).toBe('RETURN_BAD_PRICE');
    expect(r({ items: [item], totalPrice: 'minus 100' })).toBe('RETURN_BAD_TOTAL');
  });
});

describe('mapSale', () => {
  const sale = (over: Partial<LegacySale>): LegacySale => ({
    id: 's1',
    cashierId: 'u1',
    createdAt: new Date('2026-07-18T16:27:10Z'),
    items: [],
    ...over,
  });

  it('spreads the unrecorded bill discount of an old sale over the lines', () => {
    const mapped = mapSale(
      sale({
        items: [
          { medicineId: 'a', quantity: 2, price: 40 },
          { medicineId: 'b', quantity: 6, price: 46.3 },
        ],
        totalPrice: 350.79999999999995,
      }),
      vi.fn(),
    );
    expect(mapped.subtotal).toBe(35780n);
    expect(mapped.discountTotal).toBe(700n);
    expect(mapped.grandTotal).toBe(35080n);
    // Lines carry the discount by value and add up to what was paid.
    expect(mapped.lines.map((l) => [l.discount, l.lineTotal])).toEqual([
      [157n, 7843n],
      [543n, 27237n],
    ]);
    for (const l of mapped.lines)
      expect(l.lineTotal).toBe(BigInt(l.quantity) * l.unitPrice - l.discount);
    expect(mapped.lines.reduce((a, l) => a + l.lineTotal, 0n)).toBe(mapped.grandTotal);
    expect(mapped.notes).toBe('Migrated from the old system (no bill number)');
  });

  it('prices newer sales from originalPrice and keeps the bill number', () => {
    const warn = vi.fn();
    const mapped = mapSale(
      sale({
        items: [
          { medicineId: 'a', quantity: 1, originalPrice: 2590 },
          { medicineId: 'b', quantity: 1, originalPrice: 20 },
        ],
        totalPrice: 2500,
        totalDiscount: 110,
        billNumber: 'B-2026-10-30-00041',
      }),
      warn,
    );
    expect(formatPaisa(mapped.subtotal)).toBe('2610.00');
    expect(formatPaisa(mapped.discountTotal)).toBe('110.00');
    expect(mapped.notes).toBe('Migrated from the old system, bill B-2026-10-30-00041');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the recorded discount disagrees with the lines', () => {
    const warn = vi.fn();
    mapSale(
      sale({
        items: [{ medicineId: 'a', quantity: 1, originalPrice: 100 }],
        totalPrice: 90,
        totalDiscount: 5,
      }),
      warn,
    );
    expect(warn).toHaveBeenCalledWith('DISCOUNT_DIFFERS', expect.any(String));
  });

  it('rejects returns, bad lines and totals above the lines', () => {
    const item = { medicineId: 'a', quantity: 1, price: 100 };
    const r = (over: Partial<LegacySale>) => rejection(() => mapSale(sale(over), vi.fn()));
    expect(r({ items: [item], totalPrice: -100, isReturn: true })).toBe('SALE_IS_LEGACY_RETURN');
    expect(r({ items: [item], totalPrice: -100 })).toBe('SALE_IS_LEGACY_RETURN');
    expect(r({ items: [], totalPrice: 100 })).toBe('SALE_NO_ITEMS');
    expect(r({ items: [{ ...item, quantity: 0 }], totalPrice: 100 })).toBe('SALE_BAD_QUANTITY');
    expect(r({ items: [{ ...item, price: undefined }], totalPrice: 100 })).toBe('SALE_BAD_PRICE');
    expect(r({ items: [item], totalPrice: 100.5 })).toBe('SALE_TOTAL_ABOVE_SUBTOTAL');
    expect(r({ items: [item], totalPrice: 0 })).toBe('SALE_ZERO_TOTAL');
    expect(r({ items: [item], totalPrice: 100, createdAt: 'yesterday' })).toBe('SALE_BAD_DATE');
  });
});

describe('assignReceiptNumbers', () => {
  it('numbers sales gap-free per Karachi business day, in time order', () => {
    const { numbers, lastPerDay } = assignReceiptNumbers(
      [
        { key: 'c', soldAt: new Date('2026-10-30T16:50:00Z') },
        { key: 'a', soldAt: new Date('2026-10-30T04:10:00Z') },
        // 19:30 UTC on the 30th is 00:30 on the 31st in Karachi.
        { key: 'd', soldAt: new Date('2026-10-30T19:30:00Z') },
        { key: 'b', soldAt: new Date('2026-10-30T04:10:00Z') },
      ],
      TZ,
    );
    expect(Object.fromEntries(numbers)).toEqual({
      a: 'S-20261030-0001',
      b: 'S-20261030-0002',
      c: 'S-20261030-0003',
      d: 'S-20261031-0001',
    });
    expect(Object.fromEntries(lastPerDay)).toEqual({ '2026-10-30': 3, '2026-10-31': 1 });
  });
});
