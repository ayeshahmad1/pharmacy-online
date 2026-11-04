import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { addYears, businessToday, toDateOnly } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { app, auditEntries, daysFromToday, ledgerQuantity, resetDatabase } from './helpers';
import { cash, salesSetup, sell } from './sales-fixtures';

beforeEach(resetDatabase);

function correct(auth: string, batchId: string, body: object) {
  return request(app)
    .post(`/api/inventory/batches/${batchId}/expiry-corrections`)
    .set('Authorization', auth)
    .send(body);
}

const expiryOf = async (batchId: string) =>
  toDateOnly((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).expiryDate);

const sellable = async (auth: string, medicineId: string) =>
  (await request(app).get(`/api/inventory/sellable/${medicineId}`).set('Authorization', auth)).body
    .medicine.sellableQuantity as number;

describe('POST /api/inventory/batches/:id/expiry-corrections', () => {
  it('moves an expired batch to its real date: sellable again, stock untouched, audited', async () => {
    const { pharmacist, cashier, medicine, batch } = await salesSetup();
    const med = await medicine('Loprin 75mg', '10.00');
    const b = await batch(med.id, -30, 50, 'L-1');
    const oldExpiry = daysFromToday(-30);
    const newExpiry = daysFromToday(120);

    const refused = await sell(cashier.auth, {
      items: [{ medicineId: med.id, quantity: 1 }],
      payments: [cash('10.00')],
    });
    expect(refused.status).not.toBe(201);

    const res = await correct(pharmacist.auth, b.id, {
      expiryDate: newExpiry,
      reason: 'Old system kept the previous lot date',
    });

    expect(res.status).toBe(201);
    expect(res.body.correction).toMatchObject({
      expiryBefore: oldExpiry,
      batches: [{ id: b.id, expiryDate: newExpiry, isExpired: false, quantity: 50 }],
    });
    expect(await expiryOf(b.id)).toBe(newExpiry);
    expect(await ledgerQuantity(b.id)).toBe(50);
    expect(await prisma.stockMovement.count({ where: { batchId: b.id } })).toBe(1);
    expect(await sellable(cashier.auth, med.id)).toBe(50);

    const [entry] = await auditEntries('BATCH_EXPIRY_CORRECT');
    expect(entry).toMatchObject({
      userId: pharmacist.user.id,
      entityType: 'Batch',
      entityId: b.id,
      before: { expiryDate: oldExpiry },
      after: { expiryDate: newExpiry, reason: 'Old system kept the previous lot date' },
    });

    const sold = await sell(cashier.auth, {
      items: [{ medicineId: med.id, quantity: 1 }],
      payments: [cash('10.00')],
    });
    expect(sold.status).toBe(201);
  });

  it('changes every batch of the same lot, and no other lot', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const med = await medicine('Myfol');
    const first = await batch(med.id, -10, 20, 'LOT-A');
    const topUp = await batch(med.id, -10, 5, 'LOT-A');
    const otherLot = await batch(med.id, -10, 7, 'LOT-B');
    const otherMedicine = await batch((await medicine('Fomofol')).id, -10, 3, 'LOT-A');
    const newExpiry = daysFromToday(200);

    const res = await correct(pharmacist.auth, topUp.id, {
      expiryDate: newExpiry,
      reason: 'Date on the pack',
    });

    expect(res.status).toBe(201);
    expect(res.body.correction.batches.map((b: { id: string }) => b.id)).toEqual([
      topUp.id,
      first.id,
    ]);
    expect(await expiryOf(first.id)).toBe(newExpiry);
    expect(await expiryOf(topUp.id)).toBe(newExpiry);
    expect(await expiryOf(otherLot.id)).toBe(daysFromToday(-10));
    expect(await expiryOf(otherMedicine.id)).toBe(daysFromToday(-10));
    expect((await auditEntries('BATCH_EXPIRY_CORRECT')).map((e) => e.entityId).sort()).toEqual(
      [first.id, topUp.id].sort(),
    );
  });

  it('can bring a date forward so the batch counts as expired', async () => {
    const { pharmacist, cashier, medicine, batch } = await salesSetup();
    const med = await medicine('Gaviscon');
    const b = await batch(med.id, 300, 6, 'G-1');

    const res = await correct(pharmacist.auth, b.id, {
      expiryDate: daysFromToday(-1),
      reason: 'Pack shows it expired yesterday',
    });

    expect(res.status).toBe(201);
    expect(res.body.correction.batches[0].isExpired).toBe(true);
    expect(await sellable(cashier.auth, med.id)).toBe(0);
  });

  it('refuses the same date, a typo far in the future, and a missing reason, changing nothing', async () => {
    const { pharmacist, medicine, batch } = await salesSetup();
    const b = await batch((await medicine('Meco')).id, -5, 4, 'M-1');

    const same = await correct(pharmacist.auth, b.id, {
      expiryDate: daysFromToday(-5),
      reason: 'No change',
    });
    expect(same.status).toBe(400);
    expect(same.body.error.details).toEqual({ field: 'expiryDate' });

    const tooFar = await correct(pharmacist.auth, b.id, {
      expiryDate: addYears(businessToday(), 11),
      reason: 'Typo',
    });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error.details).toEqual({ field: 'expiryDate' });

    const noReason = await correct(pharmacist.auth, b.id, {
      expiryDate: daysFromToday(100),
      reason: ' ',
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('VALIDATION_ERROR');

    expect(await expiryOf(b.id)).toBe(daysFromToday(-5));
    expect(await auditEntries('BATCH_EXPIRY_CORRECT')).toHaveLength(0);
  });

  it('returns 404 for a batch that does not exist', async () => {
    const { pharmacist } = await salesSetup();
    const res = await correct(pharmacist.auth, '00000000-0000-4000-8000-000000000000', {
      expiryDate: daysFromToday(100),
      reason: 'Date on the pack',
    });
    expect(res.status).toBe(404);
  });
});
