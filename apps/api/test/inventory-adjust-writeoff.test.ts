import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import {
  app,
  auditEntries,
  authAs,
  createBatch,
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
  const medicine = await createMedicine({ name: 'Panadol 500mg', categoryId: category.id });
  const batch = (expiryInDays: number, quantity: number, batchNumber?: string) =>
    createBatch({
      medicineId: medicine.id,
      supplierId: supplier.id,
      userId: user.id,
      expiryDate: daysFromToday(expiryInDays),
      quantity,
      batchNumber,
    });
  return { user, auth, medicine, supplier, category, batch };
}

function adjust(auth: string, body: object) {
  return request(app).post('/api/inventory/adjustments').set('Authorization', auth).send(body);
}

function writeOff(auth: string, body: object = {}) {
  return request(app)
    .post('/api/inventory/write-offs/expired')
    .set('Authorization', auth)
    .send(body);
}

describe('POST /api/inventory/adjustments', () => {
  it('adds stock with a positive ADJUSTMENT movement', async () => {
    const { auth, user, batch } = await setup();
    const b = await batch(100, 50);

    const res = await adjust(auth, {
      batchId: b.id,
      quantity: 7,
      reason: 'Recount found extra strip',
    });

    expect(res.status).toBe(201);
    expect(res.body.adjustment).toMatchObject({
      quantityBefore: 50,
      quantityAfter: 57,
      batch: { id: b.id, quantity: 57 },
      movement: { type: 'ADJUSTMENT', quantity: 7, reason: 'Recount found extra strip' },
    });
    expect(res.body.adjustment.movement.user.id).toBe(user.id);
    expect(await ledgerQuantity(b.id)).toBe(57);
  });

  it('removes stock with a negative ADJUSTMENT movement', async () => {
    const { auth, batch } = await setup();
    const b = await batch(100, 50);
    const res = await adjust(auth, { batchId: b.id, quantity: -12, reason: 'Damaged in storage' });
    expect(res.status).toBe(201);
    expect(res.body.adjustment.quantityAfter).toBe(38);
    expect(await ledgerQuantity(b.id)).toBe(38);
  });

  it('can bring a batch down to exactly zero', async () => {
    const { auth, batch } = await setup();
    const b = await batch(100, 5);
    const res = await adjust(auth, { batchId: b.id, quantity: -5, reason: 'Box lost' });
    expect(res.status).toBe(201);
    expect(await ledgerQuantity(b.id)).toBe(0);
  });

  it('rejects removing more than the batch holds, and saves nothing', async () => {
    const { auth, batch } = await setup();
    const b = await batch(100, 5);

    const res = await adjust(auth, { batchId: b.id, quantity: -6, reason: 'Recount' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { batchId: b.id, available: 5, requested: 6 },
    });
    expect(await ledgerQuantity(b.id)).toBe(5);
    expect(await prisma.stockMovement.count({ where: { type: 'ADJUSTMENT' } })).toBe(0);
    expect(await auditEntries('STOCK_ADJUST')).toHaveLength(0);
  });

  it('rejects removing anything from an empty batch', async () => {
    const { auth, batch } = await setup();
    const b = await batch(100, 3);
    await adjust(auth, { batchId: b.id, quantity: -3, reason: 'Recount' });
    const res = await adjust(auth, { batchId: b.id, quantity: -1, reason: 'Recount' });
    expect(res.status).toBe(409);
    expect(await ledgerQuantity(b.id)).toBe(0);
  });

  it('audits the change with before/after quantities and the reason', async () => {
    const { auth, user, batch } = await setup();
    const b = await batch(100, 20);
    await adjust(auth, { batchId: b.id, quantity: -2, reason: 'Broken bottles' });

    const [entry] = await auditEntries('STOCK_ADJUST');
    expect(entry).toMatchObject({
      userId: user.id,
      entityType: 'Batch',
      entityId: b.id,
      before: { quantity: 20 },
      after: { quantity: 18, change: -2, reason: 'Broken bottles' },
    });
  });

  it.each([
    ['zero quantity', { quantity: 0 }],
    ['fractional quantity', { quantity: -1.5 }],
    ['missing reason', { reason: undefined }],
    ['blank reason', { reason: '   ' }],
    ['bad batch id', { batchId: 'not-a-uuid' }],
  ])('rejects %s', async (_label, overrides) => {
    const { auth, batch } = await setup();
    const b = await batch(100, 10);
    const res = await adjust(auth, {
      batchId: b.id,
      quantity: -1,
      reason: 'Recount',
      ...overrides,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await ledgerQuantity(b.id)).toBe(10);
  });

  it('returns 404 for an unknown batch', async () => {
    const { auth } = await setup();
    const res = await adjust(auth, {
      batchId: '00000000-0000-4000-8000-000000000000',
      quantity: 1,
      reason: 'Recount',
    });
    expect(res.status).toBe(404);
  });

  it('two removals racing for the last units cannot both succeed', async () => {
    const { auth, batch } = await setup();
    const b = await batch(100, 10);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        adjust(auth, { batchId: b.id, quantity: -4, reason: 'Concurrent recount' }),
      ),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 409, 409]);
    expect(await ledgerQuantity(b.id)).toBe(2);
  });
});

describe('POST /api/inventory/write-offs/expired', () => {
  it('writes off the full remaining stock of every expired batch when no ids are given', async () => {
    const { auth, user, batch } = await setup();
    const old = await batch(-30, 40, 'OLD');
    const today = await batch(0, 12, 'TODAY'); // expires today = expired
    const fresh = await batch(30, 100, 'FRESH');
    const emptyExpired = await batch(-10, 5, 'EMPTY');
    await adjust(auth, { batchId: emptyExpired.id, quantity: -5, reason: 'Already binned' });
    await adjust(auth, { batchId: old.id, quantity: -10, reason: 'Recount' });

    const res = await writeOff(auth);

    expect(res.status).toBe(201);
    expect(res.body.writeOff.totalQuantity).toBe(42);
    expect(
      res.body.writeOff.items.map((i: { batch: { batchNumber: string }; quantity: number }) => [
        i.batch.batchNumber,
        i.quantity,
      ]),
    ).toEqual([
      ['OLD', 30],
      ['TODAY', 12],
    ]);
    expect(await ledgerQuantity(old.id)).toBe(0);
    expect(await ledgerQuantity(today.id)).toBe(0);
    expect(await ledgerQuantity(fresh.id)).toBe(100);

    const movements = await prisma.stockMovement.findMany({ where: { type: 'EXPIRED_WRITEOFF' } });
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.userId === user.id && m.quantity < 0)).toBe(true);
    expect(await auditEntries('STOCK_EXPIRED_WRITEOFF')).toHaveLength(2);
  });

  it('is a no-op when nothing has expired', async () => {
    const { auth, batch } = await setup();
    await batch(30, 100);
    const res = await writeOff(auth);
    expect(res.status).toBe(201);
    expect(res.body.writeOff).toEqual({ items: [], totalQuantity: 0 });
    expect(await prisma.stockMovement.count({ where: { type: 'EXPIRED_WRITEOFF' } })).toBe(0);
  });

  it('writes off only the named batches, with the given reason', async () => {
    const { auth, batch } = await setup();
    const a = await batch(-5, 10, 'A');
    const b = await batch(-6, 20, 'B');

    const res = await writeOff(auth, { batchIds: [a.id], reason: 'Sent back to supplier' });

    expect(res.status).toBe(201);
    expect(res.body.writeOff.items[0].movement.reason).toBe('Sent back to supplier');
    expect(await ledgerQuantity(a.id)).toBe(0);
    expect(await ledgerQuantity(b.id)).toBe(20);
  });

  it('refuses to write off a batch that has not expired, and writes off nothing', async () => {
    const { auth, batch } = await setup();
    const expired = await batch(-5, 10);
    const tomorrow = await batch(1, 10);

    const res = await writeOff(auth, { batchIds: [expired.id, tomorrow.id] });

    expect(res.status).toBe(400);
    expect(res.body.error.details.batches).toEqual([
      expect.objectContaining({ batchId: tomorrow.id }),
    ]);
    expect(await ledgerQuantity(expired.id)).toBe(10);
  });

  it('refuses a named batch with no stock left', async () => {
    const { auth, batch } = await setup();
    const b = await batch(-5, 3);
    await writeOff(auth, { batchIds: [b.id] });

    const again = await writeOff(auth, { batchIds: [b.id] });
    expect(again.status).toBe(400);
    expect(await prisma.stockMovement.count({ where: { type: 'EXPIRED_WRITEOFF' } })).toBe(1);
  });

  it('rejects unknown and duplicate batch ids', async () => {
    const { auth, batch } = await setup();
    const b = await batch(-5, 3);

    const unknown = await writeOff(auth, { batchIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(unknown.status).toBe(400);

    const dupes = await writeOff(auth, { batchIds: [b.id, b.id] });
    expect(dupes.status).toBe(400);
    expect(dupes.body.error.code).toBe('VALIDATION_ERROR');
    expect(await ledgerQuantity(b.id)).toBe(3);
  });
});
