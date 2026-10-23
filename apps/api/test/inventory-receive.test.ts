import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  auditEntries,
  authAs,
  createCategory,
  createMedicine,
  createSupplier,
  daysFromToday,
  ledgerQuantity,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

async function setup() {
  const { user, auth } = await authAs('PHARMACIST');
  const category = await createCategory();
  const supplier = await createSupplier();
  const panadol = await createMedicine({ name: 'Panadol 500mg', categoryId: category.id });
  const brufen = await createMedicine({ name: 'Brufen 400mg', categoryId: category.id });
  return { user, auth, supplier, panadol, brufen, category };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const item = (medicineId: string, overrides: Record<string, unknown> = {}) => ({
  medicineId,
  batchNumber: 'PN-2501',
  expiryDate: daysFromToday(365),
  costPrice: '1.85',
  quantity: 100,
  ...overrides,
});

function receive(auth: string, body: object) {
  return request(app).post('/api/inventory/receipts').set('Authorization', auth).send(body);
}

/** Nothing about stock changed: the all-or-nothing guarantee. */
async function expectNothingReceived() {
  expect(await prisma.batch.count()).toBe(0);
  expect(await prisma.stockMovement.count()).toBe(0);
  expect(await auditEntries('STOCK_RECEIVE')).toHaveLength(0);
}

describe('POST /api/inventory/receipts', () => {
  it('creates a batch and a matching PURCHASE movement per line', async () => {
    const { auth, user, supplier, panadol, brufen }: Setup = await setup();
    const expiry = daysFromToday(400);

    const res = await receive(auth, {
      supplierId: supplier.id,
      invoiceNumber: 'INV-7781',
      items: [
        item(panadol.id, { batchNumber: 'pn-2501', expiryDate: expiry, quantity: 200 }),
        item(brufen.id, { batchNumber: 'BR-11', costPrice: '4.4', quantity: 50 }),
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.batches).toHaveLength(2);
    const [first] = res.body.batches;
    expect(first).toMatchObject({
      medicine: { id: panadol.id, name: 'Panadol 500mg' },
      supplier: { id: supplier.id },
      batchNumber: 'PN-2501', // normalised to uppercase
      expiryDate: expiry,
      isExpired: false,
      daysToExpiry: 400,
      quantity: 200,
      quantityReceived: 200,
      costPrice: '1.85',
    });
    expect(res.body.batches[1].costPrice).toBe('4.40');

    const movements = await prisma.stockMovement.findMany({ orderBy: { quantity: 'desc' } });
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({
      batchId: first.id,
      type: 'PURCHASE',
      quantity: 200,
      reason: 'Invoice INV-7781',
      userId: user.id,
    });
    expect(await ledgerQuantity(first.id as string)).toBe(200);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: first.id } });
    expect(batch.costPrice.toFixed(2)).toBe('1.85');
    expect(batch.expiryDate.toISOString().slice(0, 10)).toBe(expiry);
  });

  it('audits every received batch with the user and invoice', async () => {
    const { auth, user, supplier, panadol } = await setup();
    const res = await receive(auth, {
      supplierId: supplier.id,
      invoiceNumber: 'INV-1',
      items: [item(panadol.id)],
    });

    const [entry] = await auditEntries('STOCK_RECEIVE');
    expect(entry).toMatchObject({
      userId: user.id,
      entityType: 'Batch',
      entityId: res.body.batches[0].id,
    });
    expect(entry?.after).toMatchObject({
      invoiceNumber: 'INV-1',
      quantity: 100,
      costPrice: '1.85',
    });
  });

  it('lets ADMIN receive stock too', async () => {
    const { supplier, panadol } = await setup();
    const { auth } = await authAs('ADMIN');
    const res = await receive(auth, { supplierId: supplier.id, items: [item(panadol.id)] });
    expect(res.status).toBe(201);
  });

  it('allows the same lot again with the same expiry, as a separate batch', async () => {
    const { auth, supplier, panadol } = await setup();
    const expiry = daysFromToday(200);
    const line = item(panadol.id, { batchNumber: 'PN-9', expiryDate: expiry });

    expect((await receive(auth, { supplierId: supplier.id, items: [line] })).status).toBe(201);
    expect((await receive(auth, { supplierId: supplier.id, items: [line] })).status).toBe(201);
    expect(await prisma.batch.count({ where: { batchNumber: 'PN-9' } })).toBe(2);
  });

  describe('rejections (nothing is saved)', () => {
    it('rejects an expiry date in the past', async () => {
      const { auth, supplier, panadol } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { expiryDate: daysFromToday(-1) })],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.details.items).toEqual([
        expect.objectContaining({ index: 0, field: 'expiryDate' }),
      ]);
      await expectNothingReceived();
    });

    it('rejects an expiry date of today (already expired)', async () => {
      const { auth, supplier, panadol } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { expiryDate: daysFromToday(0) })],
      });
      expect(res.status).toBe(400);
      await expectNothingReceived();
    });

    it('accepts an expiry date of tomorrow', async () => {
      const { auth, supplier, panadol } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { expiryDate: daysFromToday(1) })],
      });
      expect(res.status).toBe(201);
      expect(res.body.batches[0].daysToExpiry).toBe(1);
    });

    it('rejects an implausibly distant expiry date (likely a typo)', async () => {
      const { auth, supplier, panadol } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { expiryDate: '2207-01-31' })],
      });
      expect(res.status).toBe(400);
      await expectNothingReceived();
    });

    it('rejects the whole receipt when only one line is bad', async () => {
      const { auth, supplier, panadol, brufen } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [
          item(panadol.id),
          item(brufen.id, { batchNumber: 'BR-1', expiryDate: daysFromToday(-30) }),
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.items).toEqual([expect.objectContaining({ index: 1 })]);
      await expectNothingReceived();
    });

    it.each([
      ['zero quantity', { quantity: 0 }],
      ['negative quantity', { quantity: -5 }],
      ['fractional quantity', { quantity: 2.5 }],
      ['quantity as a string', { quantity: '10' }],
      ['negative cost', { costPrice: '-1.00' }],
      ['cost as a JS number', { costPrice: 1.85 }],
      ['cost with 3 decimals', { costPrice: '1.855' }],
      ['malformed expiry', { expiryDate: '31/12/2027' }],
      ['impossible expiry', { expiryDate: '2027-02-30' }],
      ['blank batch number', { batchNumber: '  ' }],
      ['batch number with spaces', { batchNumber: 'PN 25' }],
      ['unknown field', { sellingPrice: '3.00' }],
    ])('rejects %s with a validation error', async (_label, overrides) => {
      const { auth, supplier, panadol } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, overrides)],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      await expectNothingReceived();
    });

    it('rejects an empty receipt', async () => {
      const { auth, supplier } = await setup();
      const res = await receive(auth, { supplierId: supplier.id, items: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects the same batch of a medicine twice in one receipt', async () => {
      const { auth, supplier, panadol } = await setup();
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { batchNumber: 'X1' }), item(panadol.id, { batchNumber: 'x1' })],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      await expectNothingReceived();
    });

    it('rejects a known lot arriving with a different expiry date', async () => {
      const { auth, supplier, panadol } = await setup();
      await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { batchNumber: 'PN-7', expiryDate: daysFromToday(100) })],
      });

      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [item(panadol.id, { batchNumber: 'PN-7', expiryDate: daysFromToday(150) })],
      });
      expect(res.status).toBe(409);
      expect(await prisma.batch.count()).toBe(1);
    });

    it('rejects unknown and inactive medicines', async () => {
      const { auth, supplier, panadol, category } = await setup();
      const old = await createMedicine({
        name: 'Discontinued',
        categoryId: category.id,
        status: 'INACTIVE',
      });
      const res = await receive(auth, {
        supplierId: supplier.id,
        items: [
          item(panadol.id),
          item('00000000-0000-4000-8000-000000000000', { batchNumber: 'A' }),
          item(old.id, { batchNumber: 'B' }),
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.items.map((i: { index: number }) => i.index)).toEqual([1, 2]);
      await expectNothingReceived();
    });

    it('rejects unknown and inactive suppliers', async () => {
      const { auth, panadol } = await setup();
      const inactive = await createSupplier('Gone Traders', 'INACTIVE');

      for (const supplierId of ['00000000-0000-4000-8000-000000000000', inactive.id]) {
        const res = await receive(auth, { supplierId, items: [item(panadol.id)] });
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual({ field: 'supplierId' });
      }
      await expectNothingReceived();
    });
  });
});
