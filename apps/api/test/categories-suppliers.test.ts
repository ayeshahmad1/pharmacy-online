import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  auditEntries,
  authAs,
  createCategory,
  createSupplier,
  resetDatabase,
} from './helpers';

beforeEach(resetDatabase);

const names = (res: request.Response) => (res.body.items as { name: string }[]).map((i) => i.name);

describe('categories', () => {
  it('searches by name case-insensitively, filters by status and paginates', async () => {
    const { auth } = await authAs('CASHIER');
    await createCategory('Tablets');
    await createCategory('Syrups');
    await createCategory('Eye Drops');
    await createCategory('Ear Drops', 'INACTIVE');

    const get = (query: object) =>
      request(app).get('/api/categories').query(query).set('Authorization', auth);

    expect(names(await get({ q: 'DROPS' }))).toEqual(['Ear Drops', 'Eye Drops']);
    expect(names(await get({ q: 'drops', status: 'ACTIVE' }))).toEqual(['Eye Drops']);

    const page2 = await get({ pageSize: 2, page: 2 });
    expect(page2.body).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(names(page2)).toEqual(['Syrups', 'Tablets']);
  });

  it('treats % and _ in the search term literally', async () => {
    const { auth } = await authAs('CASHIER');
    await createCategory('100% Herbal');
    await createCategory('1000 Series');
    await createCategory('Cold_Chain');
    await createCategory('Cold Chain');

    const get = (q: string) =>
      request(app).get('/api/categories').query({ q }).set('Authorization', auth);
    expect(names(await get('100%'))).toEqual(['100% Herbal']);
    expect(names(await get('cold_'))).toEqual(['Cold_Chain']);
  });

  it('creates, updates and audits; names are unique case-insensitively', async () => {
    const { user, auth } = await authAs('PHARMACIST');

    const created = await request(app)
      .post('/api/categories')
      .set('Authorization', auth)
      .send({ name: '  Tablets ', description: '' });
    expect(created.status).toBe(201);
    expect(created.body.category).toMatchObject({ name: 'Tablets', description: null });

    const dup = await request(app)
      .post('/api/categories')
      .set('Authorization', auth)
      .send({ name: 'TABLETS' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const id = created.body.category.id as string;
    const updated = await request(app)
      .patch(`/api/categories/${id}`)
      .set('Authorization', auth)
      .send({ description: 'Oral solid dosage forms' });
    expect(updated.status).toBe(200);

    // Renaming to its own name in a different case is not a clash with itself.
    await request(app)
      .patch(`/api/categories/${id}`)
      .set('Authorization', auth)
      .send({ name: 'tablets' })
      .expect(200);

    const [entry] = await auditEntries('CATEGORY_UPDATE');
    expect(entry).toMatchObject({ userId: user.id, entityType: 'Category', entityId: id });
    expect(entry!.before).toMatchObject({ description: null });
    expect(entry!.after).toMatchObject({ description: 'Oral solid dosage forms' });
    expect(await auditEntries('CATEGORY_CREATE')).toHaveLength(1);
  });

  it('deactivation keeps the row and its medicines', async () => {
    const { auth } = await authAs('ADMIN');
    const c = await createCategory('Tablets');
    await prisma.medicine.create({
      data: { name: 'Panadol', categoryId: c.id, unit: 'tablet', sellingPrice: '2.00' },
    });

    const res = await request(app)
      .post(`/api/categories/${c.id}/deactivate`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.category.status).toBe('INACTIVE');
    expect(await prisma.medicine.findFirst({ where: { categoryId: c.id } })).not.toBeNull();
    expect(await auditEntries('CATEGORY_DEACTIVATE')).toHaveLength(1);
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const { auth } = await authAs('CASHIER');
    await request(app)
      .get('/api/categories/00000000-0000-4000-8000-000000000000')
      .set('Authorization', auth)
      .expect(404);
    await request(app).get('/api/categories/abc').set('Authorization', auth).expect(400);
  });
});

describe('suppliers', () => {
  it('searches name, contact person and phone', async () => {
    const { auth } = await authAs('CASHIER');
    await prisma.supplier.createMany({
      data: [
        { name: 'Pak Pharma', contactPerson: 'Imran Khan', phone: '0300-1112233' },
        { name: 'Medi Traders', contactPerson: 'Sana Ali', phone: '0321-4445566' },
        { name: 'Karachi Distributors', contactPerson: null, phone: null },
      ],
    });

    const get = (q: string) =>
      request(app).get('/api/suppliers').query({ q }).set('Authorization', auth);
    expect(names(await get('pharma'))).toEqual(['Pak Pharma']);
    expect(names(await get('sana'))).toEqual(['Medi Traders']);
    expect(names(await get('0321'))).toEqual(['Medi Traders']);
    expect(names(await get('a'))).toEqual(['Karachi Distributors', 'Medi Traders', 'Pak Pharma']);
  });

  it('filters by status and paginates', async () => {
    const { auth } = await authAs('CASHIER');
    for (const n of ['A', 'B', 'C', 'D', 'E']) await createSupplier(`Supplier ${n}`);
    await createSupplier('Supplier Z', 'INACTIVE');

    const res = await request(app)
      .get('/api/suppliers')
      .query({ status: 'ACTIVE', pageSize: 2, page: 3 })
      .set('Authorization', auth);
    expect(res.body).toMatchObject({ total: 5, page: 3, pageSize: 2 });
    expect(names(res)).toEqual(['Supplier E']);
  });

  it('validates contact fields and normalises blanks to null', async () => {
    const { auth } = await authAs('PHARMACIST');

    const bad = await request(app)
      .post('/api/suppliers')
      .set('Authorization', auth)
      .send({ name: 'X', email: 'not-an-email', phone: 'call me' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.body.fieldErrors).toHaveProperty('email');
    expect(bad.body.error.details.body.fieldErrors).toHaveProperty('phone');

    const ok = await request(app)
      .post('/api/suppliers')
      .set('Authorization', auth)
      .send({ name: 'Pak Pharma', email: 'Orders@PakPharma.pk', phone: '', address: ' ' });
    expect(ok.status).toBe(201);
    expect(ok.body.supplier).toMatchObject({
      email: 'orders@pakpharma.pk',
      phone: null,
      address: null,
      contactPerson: null,
    });
  });

  it('rejects a duplicate name, audits create/update/deactivate', async () => {
    const { user, auth } = await authAs('ADMIN');
    const s = await createSupplier('Pak Pharma');

    await request(app)
      .post('/api/suppliers')
      .set('Authorization', auth)
      .send({ name: 'pak pharma' })
      .expect(409);

    await request(app)
      .patch(`/api/suppliers/${s.id}`)
      .set('Authorization', auth)
      .send({ phone: '0300 1234567' })
      .expect(200);
    await request(app)
      .post(`/api/suppliers/${s.id}/deactivate`)
      .set('Authorization', auth)
      .expect(200);

    const [update] = await auditEntries('SUPPLIER_UPDATE');
    expect(update).toMatchObject({ userId: user.id, entityId: s.id });
    expect(update!.before).toMatchObject({ phone: null });
    expect(update!.after).toMatchObject({ phone: '0300 1234567' });
    expect(await auditEntries('SUPPLIER_DEACTIVATE')).toHaveLength(1);
    expect(await auditEntries('SUPPLIER_CREATE')).toHaveLength(0);
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({
      status: 'INACTIVE',
    });
  });
});
