import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  auditEntries,
  authAs,
  createCategory,
  createMedicine,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

async function list(auth: string, query: Record<string, string | number> = {}) {
  const res = await request(app).get('/api/medicines').query(query).set('Authorization', auth);
  expect(res.status).toBe(200);
  return res.body as { items: { name: string }[]; total: number; page: number; pageSize: number };
}

const names = (body: { items: { name: string }[] }) => body.items.map((m) => m.name);

describe('GET /api/medicines search', () => {
  async function seedCatalogue() {
    const tablets = await createCategory('Tablets');
    const syrups = await createCategory('Syrups');
    const m = (name: string, genericName: string | null, categoryId = tablets.id) =>
      createMedicine({ name, genericName, categoryId });
    await m('Panadol 500mg', 'Paracetamol');
    await m('Calpol Syrup', 'Paracetamol', syrups.id);
    await m('Brufen 400mg', 'Ibuprofen');
    await m('Augmentin 625mg', 'Amoxicillin + Clavulanic Acid');
    await m('Risek 20mg', 'Omeprazole');
    await m('Cotton Roll', null);
    return { tablets, syrups };
  }

  it('matches the brand name, case-insensitively, anywhere in the name', async () => {
    const { auth } = await authAs('CASHIER');
    await seedCatalogue();

    expect(names(await list(auth, { q: 'PANA' }))).toEqual(['Panadol 500mg']);
    expect(names(await list(auth, { q: '625' }))).toEqual(['Augmentin 625mg']);
  });

  it('matches the generic/salt name', async () => {
    const { auth } = await authAs('CASHIER');
    await seedCatalogue();

    expect(names(await list(auth, { q: 'paracetamol' }))).toEqual([
      'Calpol Syrup',
      'Panadol 500mg',
    ]);
    expect(names(await list(auth, { q: 'clavulanic' }))).toEqual(['Augmentin 625mg']);
  });

  it('medicines without a generic name are still found by brand name', async () => {
    const { auth } = await authAs('CASHIER');
    await seedCatalogue();
    expect(names(await list(auth, { q: 'cotton' }))).toEqual(['Cotton Roll']);
  });

  it('returns an empty page, not an error, when nothing matches', async () => {
    const { auth } = await authAs('CASHIER');
    await seedCatalogue();
    expect(await list(auth, { q: 'zzz' })).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('ranks exact name, then name prefix, then generic prefix, then other matches', async () => {
    const { auth } = await authAs('CASHIER');
    const c = await createCategory();
    const m = (name: string, genericName: string) =>
      createMedicine({ name, genericName, categoryId: c.id });
    await m('Zinc Ascorbate', 'Zinc');
    await m('Bascopan', 'Hyoscine');
    await m('Ascard 75mg', 'Aspirin');
    await m('C-Vit', 'Ascorbic acid');
    await m('Ascard', 'Aspirin');

    expect(names(await list(auth, { q: 'ascard' }))).toEqual(['Ascard', 'Ascard 75mg']);
    // Plain alphabetical order would put Bascopan before C-Vit.
    expect(names(await list(auth, { q: 'asc' }))).toEqual([
      'Ascard', // name prefix
      'Ascard 75mg', // name prefix
      'C-Vit', // generic prefix
      'Bascopan', // name contains
      'Zinc Ascorbate', // name contains
    ]);
  });

  it('treats % and _ in the search term literally', async () => {
    const { auth } = await authAs('CASHIER');
    const c = await createCategory();
    await createMedicine({ name: 'Dettol 5% Solution', categoryId: c.id });
    await createMedicine({ name: 'Dettol 50ml', categoryId: c.id });
    await createMedicine({ name: 'Vit_D Drops', categoryId: c.id });
    await createMedicine({ name: 'VitaD Drops', categoryId: c.id });

    expect(names(await list(auth, { q: '5%' }))).toEqual(['Dettol 5% Solution']);
    expect(names(await list(auth, { q: 'vit_d' }))).toEqual(['Vit_D Drops']);
    expect((await list(auth, { q: '%' })).total).toBe(1);
  });

  it('filters by category and status, alone and combined with search', async () => {
    const { auth } = await authAs('CASHIER');
    const { syrups } = await seedCatalogue();
    const panadol = await prisma.medicine.findFirstOrThrow({ where: { name: 'Panadol 500mg' } });
    await prisma.medicine.update({ where: { id: panadol.id }, data: { status: 'INACTIVE' } });

    expect(names(await list(auth, { categoryId: syrups.id }))).toEqual(['Calpol Syrup']);
    expect(names(await list(auth, { status: 'INACTIVE' }))).toEqual(['Panadol 500mg']);
    expect(names(await list(auth, { q: 'paracetamol', status: 'ACTIVE' }))).toEqual([
      'Calpol Syrup',
    ]);
    expect(names(await list(auth, { q: 'paracetamol' }))).toHaveLength(2);
    expect((await list(auth, { status: 'ACTIVE' })).total).toBe(5);
  });

  it('paginates with a stable order and a total that ignores paging', async () => {
    const { auth } = await authAs('CASHIER');
    const c = await createCategory();
    for (let i = 1; i <= 25; i++) {
      await createMedicine({
        name: `Med ${String(i).padStart(2, '0')}`,
        genericName: 'Generic',
        categoryId: c.id,
      });
    }

    const p1 = await list(auth, { pageSize: 10 });
    const p3 = await list(auth, { pageSize: 10, page: 3 });
    expect(p1).toMatchObject({ total: 25, page: 1, pageSize: 10 });
    expect(names(p1)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Med ${String(i + 1).padStart(2, '0')}`),
    );
    expect(names(p3)).toEqual(['Med 21', 'Med 22', 'Med 23', 'Med 24', 'Med 25']);

    // Pagination also applies to search results.
    const searched = await list(auth, { q: 'generic', pageSize: 10, page: 2 });
    expect(searched.total).toBe(25);
    expect(names(searched)[0]).toBe('Med 11');

    expect((await list(auth, { page: 9 })).items).toEqual([]);
  });

  it('rejects bad query parameters with VALIDATION_ERROR', async () => {
    const { auth } = await authAs('CASHIER');
    for (const query of [
      { page: 0 },
      { pageSize: 101 },
      { categoryId: 'not-a-uuid' },
      { status: 'DELETED' },
      { q: '   ' },
    ]) {
      const res = await request(app).get('/api/medicines').query(query).set('Authorization', auth);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns the DTO shape with category and a 2-decimal price string', async () => {
    const { auth } = await authAs('CASHIER');
    const c = await createCategory('Tablets');
    await createMedicine({ name: 'Panadol', categoryId: c.id, barcode: '8964000123456' });

    const [item] = (await list(auth)).items;
    expect(item).toEqual({
      id: expect.any(String),
      name: 'Panadol',
      genericName: null,
      barcode: '8964000123456',
      category: { id: c.id, name: 'Tablets' },
      unit: 'tablet',
      reorderLevel: 0,
      sellingPrice: '10.00',
      status: 'ACTIVE',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('has trigram indexes on name and generic name so substring search stays fast', async () => {
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'Medicine'`;
    const defs = indexes.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(/USING gin \(name gin_trgm_ops\)/);
    expect(defs).toMatch(/USING gin \("genericName" gin_trgm_ops\)/);
  });
});

describe('medicine writes', () => {
  const body = (categoryId: string, extra: object = {}) => ({
    name: 'Panadol 500mg',
    genericName: 'Paracetamol',
    barcode: '8964000123456',
    categoryId,
    unit: 'Tablet',
    reorderLevel: 50,
    sellingPrice: '2.5',
    ...extra,
  });

  it('creates a medicine, normalising unit and price, and audits it', async () => {
    const { user, auth } = await authAs('PHARMACIST');
    const c = await createCategory();

    const res = await request(app)
      .post('/api/medicines')
      .set('Authorization', auth)
      .send(body(c.id));
    expect(res.status).toBe(201);
    expect(res.body.medicine).toMatchObject({
      name: 'Panadol 500mg',
      unit: 'tablet',
      reorderLevel: 50,
      sellingPrice: '2.50',
      status: 'ACTIVE',
    });

    const [entry] = await auditEntries('MEDICINE_CREATE');
    expect(entry).toMatchObject({
      userId: user.id,
      entityType: 'Medicine',
      entityId: res.body.medicine.id,
    });
    expect(entry!.after).toMatchObject({ name: 'Panadol 500mg', sellingPrice: '2.50' });
  });

  it('defaults reorder level to 0 and stores a blank barcode as null', async () => {
    const { auth } = await authAs('PHARMACIST');
    const c = await createCategory();
    const res = await request(app).post('/api/medicines').set('Authorization', auth).send({
      name: 'Cotton Roll',
      categoryId: c.id,
      unit: 'roll',
      sellingPrice: '80',
      barcode: '  ',
    });
    expect(res.status).toBe(201);
    expect(res.body.medicine).toMatchObject({ reorderLevel: 0, barcode: null, genericName: null });
  });

  it.each([
    ['a JS number', 2.5],
    ['three decimals', '2.505'],
    ['a negative amount', '-1'],
    ['text', 'free'],
  ])('rejects a selling price given as %s', async (_label, sellingPrice) => {
    const { auth } = await authAs('PHARMACIST');
    const c = await createCategory();
    const res = await request(app)
      .post('/api/medicines')
      .set('Authorization', auth)
      .send(body(c.id, { sellingPrice }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a negative reorder level and unknown fields', async () => {
    const { auth } = await authAs('PHARMACIST');
    const c = await createCategory();
    for (const extra of [{ reorderLevel: -1 }, { reorderLevel: 1.5 }, { stock: 100 }]) {
      const res = await request(app)
        .post('/api/medicines')
        .set('Authorization', auth)
        .send(body(c.id, extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await prisma.medicine.count()).toBe(0);
  });

  it('rejects a missing or inactive category', async () => {
    const { auth } = await authAs('PHARMACIST');
    const inactive = await createCategory('Old', 'INACTIVE');

    for (const categoryId of [inactive.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await request(app)
        .post('/api/medicines')
        .set('Authorization', auth)
        .send(body(categoryId));
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual({ field: 'categoryId' });
    }
    expect(await prisma.medicine.count()).toBe(0);
    expect(await auditEntries('MEDICINE_CREATE')).toHaveLength(0);
  });

  it('rejects a duplicate barcode with 409', async () => {
    const { auth } = await authAs('PHARMACIST');
    const c = await createCategory();
    await createMedicine({ name: 'Panadol', categoryId: c.id, barcode: '8964000123456' });

    const res = await request(app)
      .post('/api/medicines')
      .set('Authorization', auth)
      .send(body(c.id));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { field: 'barcode' } });
  });

  it('updates fields, records before/after, and can clear optional fields', async () => {
    const { auth } = await authAs('ADMIN');
    const c = await createCategory();
    const other = await createCategory('Analgesics');
    const med = await createMedicine({
      name: 'Panadol',
      genericName: 'Paracetamol',
      categoryId: c.id,
    });

    const res = await request(app)
      .patch(`/api/medicines/${med.id}`)
      .set('Authorization', auth)
      .send({ sellingPrice: '12.5', genericName: null, categoryId: other.id, reorderLevel: 20 });
    expect(res.status).toBe(200);
    expect(res.body.medicine).toMatchObject({
      sellingPrice: '12.50',
      genericName: null,
      category: { id: other.id, name: 'Analgesics' },
      reorderLevel: 20,
    });

    const [entry] = await auditEntries('MEDICINE_UPDATE');
    expect(entry!.before).toMatchObject({ sellingPrice: '10.00', genericName: 'Paracetamol' });
    expect(entry!.after).toMatchObject({ sellingPrice: '12.50', genericName: null });
  });

  it('keeps a medicine in an inactive category editable, but cannot move one into it', async () => {
    const { auth } = await authAs('ADMIN');
    const old = await createCategory('Old', 'INACTIVE');
    const active = await createCategory('Active');
    const inOld = await createMedicine({ name: 'Legacy', categoryId: old.id });
    const inActive = await createMedicine({ name: 'Current', categoryId: active.id });

    await request(app)
      .patch(`/api/medicines/${inOld.id}`)
      .set('Authorization', auth)
      .send({ reorderLevel: 5, categoryId: old.id })
      .expect(200);
    await request(app)
      .patch(`/api/medicines/${inActive.id}`)
      .set('Authorization', auth)
      .send({ categoryId: old.id })
      .expect(400);
  });

  it('rejects an empty update and an unknown id', async () => {
    const { auth } = await authAs('ADMIN');
    const c = await createCategory();
    const med = await createMedicine({ name: 'Panadol', categoryId: c.id });

    await request(app)
      .patch(`/api/medicines/${med.id}`)
      .set('Authorization', auth)
      .send({})
      .expect(400);
    await request(app)
      .patch('/api/medicines/00000000-0000-4000-8000-000000000000')
      .set('Authorization', auth)
      .send({ name: 'X' })
      .expect(404);
  });

  it('deactivates softly, audits once, and can reactivate', async () => {
    const { auth } = await authAs('PHARMACIST');
    const c = await createCategory();
    const med = await createMedicine({ name: 'Panadol', categoryId: c.id });

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .post(`/api/medicines/${med.id}/deactivate`)
        .set('Authorization', auth);
      expect(res.status).toBe(200);
      expect(res.body.medicine.status).toBe('INACTIVE');
    }
    // Still there, just hidden from an ACTIVE-only list.
    expect(await prisma.medicine.count()).toBe(1);
    expect((await list(auth, { status: 'ACTIVE' })).total).toBe(0);
    expect(await auditEntries('MEDICINE_DEACTIVATE')).toHaveLength(1);

    await request(app)
      .post(`/api/medicines/${med.id}/activate`)
      .set('Authorization', auth)
      .expect(200);
    expect((await list(auth, { status: 'ACTIVE' })).total).toBe(1);
  });
});
