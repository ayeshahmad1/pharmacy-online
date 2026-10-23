import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  authAs,
  createBatch,
  createCategory,
  createMedicine,
  createSupplier,
  daysFromToday,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

async function setup() {
  const { user, auth } = await authAs('CASHIER');
  const category = await createCategory();
  const supplier = await createSupplier();
  const medicine = async (opts: {
    name: string;
    genericName?: string;
    barcode?: string;
    sellingPrice?: string;
    status?: 'ACTIVE' | 'INACTIVE';
    reorderLevel?: number;
  }) => {
    const m = await createMedicine({ ...opts, categoryId: category.id });
    if (opts.reorderLevel !== undefined) {
      await prisma.medicine.update({
        where: { id: m.id },
        data: { reorderLevel: opts.reorderLevel },
      });
    }
    const batch = (expiryInDays: number, quantity: number) =>
      createBatch({
        medicineId: m.id,
        supplierId: supplier.id,
        userId: user.id,
        expiryDate: daysFromToday(expiryInDays),
        quantity,
      });
    return { ...m, batch };
  };
  return { auth, medicine };
}

const search = (auth: string, query: Record<string, string | number>) =>
  request(app).get('/api/inventory/sellable').query(query).set('Authorization', auth);

describe('GET /api/inventory/sellable', () => {
  it('returns price and sellable stock, keeping expired stock apart', async () => {
    const { auth, medicine } = await setup();
    const panadol = await medicine({
      name: 'Panadol',
      genericName: 'Paracetamol',
      sellingPrice: '25.50',
      reorderLevel: 40,
    });
    await panadol.batch(90, 30);
    await panadol.batch(20, 5);
    await panadol.batch(-2, 12);

    const res = await search(auth, { q: 'pana' });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        id: panadol.id,
        name: 'Panadol',
        genericName: 'Paracetamol',
        barcode: null,
        unit: 'tablet',
        sellingPrice: '25.50',
        sellableQuantity: 35,
        expiredQuantity: 12,
        isLowStock: true,
        nextExpiry: daysFromToday(20),
        barcodeMatch: false,
      },
    ]);
  });

  it('finds a medicine by exact barcode and flags the match', async () => {
    const { auth, medicine } = await setup();
    const brufen = await medicine({ name: 'Brufen', barcode: '8964000123457' });
    await medicine({ name: 'Calpol' });

    const res = await search(auth, { q: '8964000123457' });

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: brufen.id, barcodeMatch: true });
    // A partial barcode is not a scan.
    expect((await search(auth, { q: '896400' })).body.items).toEqual([]);
  });

  it('ranks exact name, name prefix, generic prefix, then the rest', async () => {
    const { auth, medicine } = await setup();
    await medicine({ name: 'Co-Panadol' });
    await medicine({ name: 'Panadol Extra' });
    await medicine({ name: 'Calpol', genericName: 'Panadol-like' });
    await medicine({ name: 'Panadol' });

    const res = await search(auth, { q: 'panadol' });

    expect(res.body.items.map((m: { name: string }) => m.name)).toEqual([
      'Panadol',
      'Panadol Extra',
      'Calpol',
      'Co-Panadol',
    ]);
  });

  it('includes out-of-stock medicines but never inactive ones', async () => {
    const { auth, medicine } = await setup();
    await medicine({ name: 'Augmentin 625' });
    await medicine({ name: 'Augmentin 1g', status: 'INACTIVE' });

    const res = await search(auth, { q: 'augmentin' });

    expect(res.body.items).toEqual([
      expect.objectContaining({ name: 'Augmentin 625', sellableQuantity: 0, nextExpiry: null }),
    ]);
  });

  it('matches wildcard characters literally and respects the limit', async () => {
    const { auth, medicine } = await setup();
    await medicine({ name: 'Zinc 50% gel' });
    await medicine({ name: 'Zinc 500' });
    for (const n of [1, 2, 3]) await medicine({ name: `Vitamin ${n}` });

    expect((await search(auth, { q: '50%' })).body.items).toHaveLength(1);
    expect((await search(auth, { q: 'vitamin', limit: 2 })).body.items).toHaveLength(2);
  });

  it('requires a search term and a signed-in user', async () => {
    const { auth } = await setup();
    expect((await search(auth, {})).status).toBe(400);
    expect((await request(app).get('/api/inventory/sellable').query({ q: 'x' })).status).toBe(401);
  });
});

describe('GET /api/inventory/medicines/:id/substitutes', () => {
  it('lists in-stock medicines with the same generic name, largest stock first', async () => {
    const { auth, medicine } = await setup();
    const panadol = await medicine({ name: 'Panadol', genericName: 'Paracetamol' });
    await panadol.batch(-1, 10); // only expired stock left
    const calpol = await medicine({ name: 'Calpol', genericName: 'paracetamol' });
    await calpol.batch(100, 5);
    const tylenol = await medicine({ name: 'Tylenol', genericName: 'Paracetamol' });
    await tylenol.batch(100, 50);
    await medicine({ name: 'Disprol', genericName: 'Paracetamol' }); // out of stock
    const inactive = await medicine({
      name: 'Old Para',
      genericName: 'Paracetamol',
      status: 'INACTIVE',
    });
    await inactive.batch(100, 99);
    const brufen = await medicine({ name: 'Brufen', genericName: 'Ibuprofen' });
    await brufen.batch(100, 99);

    const res = await request(app)
      .get(`/api/inventory/medicines/${panadol.id}/substitutes`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.medicine).toMatchObject({
      id: panadol.id,
      sellableQuantity: 0,
      expiredQuantity: 10,
    });
    expect(res.body.substitutes.map((m: { name: string }) => m.name)).toEqual([
      'Tylenol',
      'Calpol',
    ]);
  });

  it('returns no substitutes for a medicine without a generic name', async () => {
    const { auth, medicine } = await setup();
    const m = await medicine({ name: 'House Syrup' });
    await medicine({ name: 'Other' });

    const res = await request(app)
      .get(`/api/inventory/medicines/${m.id}/substitutes`)
      .set('Authorization', auth);

    expect(res.body.substitutes).toEqual([]);
  });

  it('404s for an unknown medicine', async () => {
    const { auth } = await setup();
    const res = await request(app)
      .get('/api/inventory/medicines/00000000-0000-4000-8000-000000000000/substitutes')
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});
