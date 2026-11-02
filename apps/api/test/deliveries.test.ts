import type { DeliveryDto, DeliveryItemInput, DeliverySummaryDto } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromDateOnly } from '../src/lib/dates';
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
  const cashier = await authAs('CASHIER');
  const pharmacist = await authAs('PHARMACIST');
  const category = await createCategory();
  const supplier = await createSupplier();
  const panadol = await createMedicine({ name: 'Panadol 500mg', categoryId: category.id });
  return { cashier, pharmacist, category, supplier, panadol };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const line = (medicineId: string, over: Partial<DeliveryItemInput> = {}) => ({
  medicineId,
  batchNumber: 'PN-2401',
  expiryDate: daysFromToday(400),
  costPrice: '7.50',
  quantity: 100,
  ...over,
});

const proposal = (s: Setup, over: object = {}) => ({
  name: 'Calpol Syrup 120ml',
  genericName: 'Paracetamol',
  barcode: '8964000123456',
  categoryId: s.category.id,
  unit: 'bottle',
  sellingPrice: '185.00',
  ...over,
});

const post = (auth: string, body: object) =>
  request(app).post('/api/deliveries').set('Authorization', auth).send(body);
const act = (auth: string, id: string, action: 'approve' | 'reject', body: object = {}) =>
  request(app).post(`/api/deliveries/${id}/${action}`).set('Authorization', auth).send(body);
const put = (auth: string, id: string, body: object) =>
  request(app).put(`/api/deliveries/${id}`).set('Authorization', auth).send(body);
const get = (auth: string, id: string) =>
  request(app).get(`/api/deliveries/${id}`).set('Authorization', auth);

const delivery = (res: request.Response) => (res.body as { delivery: DeliveryDto }).delivery;

async function pendingFromCashier(s: Setup, items: object[] = [line(s.panadol.id)]) {
  const res = await post(s.cashier.auth, {
    supplierId: s.supplier.id,
    invoiceNumber: 'INV-77',
    items,
  });
  expect(res.status).toBe(201);
  return delivery(res);
}

describe('deliveries', () => {
  it("a cashier's delivery waits as pending and puts nothing into stock", async () => {
    const s = await setup();
    const d = await pendingFromCashier(s);

    expect(d).toMatchObject({
      status: 'PENDING',
      invoiceNumber: 'INV-77',
      requestedBy: { id: s.cashier.user.id },
      reviewedBy: null,
      lineCount: 1,
      units: 100,
      totalCost: '750.00',
    });
    expect(d.items[0]).toMatchObject({ batchNumber: 'PN-2401', costPrice: '7.50', batchId: null });
    expect(await prisma.batch.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(await auditEntries('DELIVERY_CREATE')).toHaveLength(1);
  });

  it("a pharmacist's own delivery goes into stock at once", async () => {
    const s = await setup();
    const res = await post(s.pharmacist.auth, {
      supplierId: s.supplier.id,
      items: [line(s.panadol.id), line(s.panadol.id, { batchNumber: 'PN-2402', quantity: 20 })],
    });
    expect(res.status).toBe(201);
    const d = delivery(res);

    expect(d).toMatchObject({ status: 'APPROVED', reviewedBy: { id: s.pharmacist.user.id } });
    const [a, b] = d.items;
    expect(await ledgerQuantity(a!.batchId!)).toBe(100);
    expect(await ledgerQuantity(b!.batchId!)).toBe(20);
    const movements = await prisma.stockMovement.findMany();
    expect(movements.every((m) => m.type === 'PURCHASE' && m.userId === s.pharmacist.user.id)).toBe(
      true,
    );
  });

  it('approval creates the batches, and one new medicine however many lines it has', async () => {
    const s = await setup();
    const calpol = proposal(s);
    const d = await pendingFromCashier(s, [
      line(s.panadol.id),
      { ...line(''), medicineId: undefined, newMedicine: calpol, batchNumber: 'CS-1' },
      { ...line(''), medicineId: undefined, newMedicine: calpol, batchNumber: 'CS-2', quantity: 5 },
    ]);
    expect(d.newMedicineCount).toBe(2);
    expect(d.items[1]).toMatchObject({
      medicine: null,
      newMedicine: { name: 'Calpol Syrup 120ml', category: { id: s.category.id }, unit: 'bottle' },
    });
    expect(await prisma.medicine.count()).toBe(1);

    const res = await act(s.pharmacist.auth, d.id, 'approve');
    expect(res.status).toBe(200);
    const approved = delivery(res);

    expect(approved).toMatchObject({
      status: 'APPROVED',
      reviewedBy: { id: s.pharmacist.user.id },
    });
    const created = await prisma.medicine.findMany({ where: { name: 'Calpol Syrup 120ml' } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ barcode: '8964000123456', unit: 'bottle' });
    expect(created[0]!.sellingPrice.toFixed(2)).toBe('185.00');
    expect(approved.items[1]!.medicine?.id).toBe(created[0]!.id);
    expect(approved.items[2]!.medicine?.id).toBe(created[0]!.id);
    expect(approved.items[1]!.newMedicine?.name).toBe('Calpol Syrup 120ml');

    const quantities = await Promise.all(approved.items.map((i) => ledgerQuantity(i.batchId!)));
    expect(quantities).toEqual([100, 100, 5]);
    const movements = await prisma.stockMovement.findMany();
    expect(movements.every((m) => m.userId === s.pharmacist.user.id)).toBe(true);
    expect(movements.every((m) => m.reason === 'Invoice INV-77')).toBe(true);
    expect(await auditEntries('MEDICINE_CREATE')).toHaveLength(1);
    expect(await auditEntries('DELIVERY_APPROVE')).toHaveLength(1);

    // Only once.
    expect((await act(s.pharmacist.auth, d.id, 'approve')).status).toBe(409);
    expect(await prisma.batch.count()).toBe(3);
  });

  it('only approvers approve or reject, and cashiers only see their own', async () => {
    const s = await setup();
    const other = await authAs('CASHIER', 'cashier2');
    const d = await pendingFromCashier(s);

    expect((await act(s.cashier.auth, d.id, 'approve')).status).toBe(403);
    expect((await act(s.cashier.auth, d.id, 'reject', { reason: 'nope' })).status).toBe(403);
    expect((await get(other.auth, d.id)).status).toBe(404);
    expect(
      (await put(other.auth, d.id, { supplierId: s.supplier.id, items: [line(s.panadol.id)] }))
        .status,
    ).toBe(404);
    expect((await get(s.cashier.auth, d.id)).status).toBe(200);
    expect((await request(app).get('/api/deliveries')).status).toBe(401);

    const list = async (auth: string, query: object = {}) =>
      (
        (await request(app).get('/api/deliveries').query(query).set('Authorization', auth))
          .body as { items: DeliverySummaryDto[]; total: number }
      ).total;
    expect(await list(other.auth)).toBe(0);
    expect(await list(s.cashier.auth)).toBe(1);
    // A cashier can't widen the list to someone else's.
    expect(await list(other.auth, { requestedById: s.cashier.user.id })).toBe(0);
    expect(await list(s.pharmacist.auth, { status: 'PENDING' })).toBe(1);
    expect(await list(s.pharmacist.auth, { status: 'APPROVED' })).toBe(0);
    expect(await list(s.pharmacist.auth, { q: 'inv-7' })).toBe(1);
    expect(await list(s.pharmacist.auth, { q: 'pak pharma' })).toBe(1);
    expect(await list(s.pharmacist.auth, { q: 'nothing' })).toBe(0);
  });

  it('an approver can correct a pending delivery before approving it; the original stays in the audit log', async () => {
    const s = await setup();
    const d = await pendingFromCashier(s);

    // The cashier fixing their own typo is not a correction.
    const own = await put(s.cashier.auth, d.id, {
      supplierId: s.supplier.id,
      invoiceNumber: 'INV-77',
      items: [line(s.panadol.id, { quantity: 90 })],
    });
    expect(own.status).toBe(200);
    expect(delivery(own)).toMatchObject({ units: 90, correctedBy: null });

    const fixed = await put(s.pharmacist.auth, d.id, {
      supplierId: s.supplier.id,
      invoiceNumber: 'INV-77',
      items: [line(s.panadol.id, { quantity: 80, costPrice: '7.00' })],
    });
    expect(fixed.status).toBe(200);
    expect(delivery(fixed)).toMatchObject({
      status: 'PENDING',
      units: 80,
      totalCost: '560.00',
      correctedBy: { id: s.pharmacist.user.id },
    });
    expect(await prisma.batch.count()).toBe(0);

    const [, correction] = await auditEntries('DELIVERY_UPDATE');
    expect(correction).toMatchObject({
      before: { units: 90, totalCost: '675.00' },
      after: { units: 80, totalCost: '560.00' },
    });

    const approved = delivery(await act(s.pharmacist.auth, d.id, 'approve'));
    expect(await ledgerQuantity(approved.items[0]!.batchId!)).toBe(80);
    const [batch] = await prisma.batch.findMany();
    expect(batch!.costPrice.toFixed(2)).toBe('7.00');

    // Approved deliveries are history.
    const late = await put(s.pharmacist.auth, d.id, {
      supplierId: s.supplier.id,
      items: [line(s.panadol.id)],
    });
    expect(late.status).toBe(409);
  });

  it('a rejection needs a reason and puts nothing into stock', async () => {
    const s = await setup();
    const d = await pendingFromCashier(s);

    expect((await act(s.pharmacist.auth, d.id, 'reject', {})).status).toBe(400);
    const res = await act(s.pharmacist.auth, d.id, 'reject', { reason: 'Wrong supplier' });
    expect(res.status).toBe(200);
    expect(delivery(res)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Wrong supplier',
      reviewedBy: { id: s.pharmacist.user.id },
    });
    expect(await prisma.batch.count()).toBe(0);
    expect((await act(s.pharmacist.auth, d.id, 'approve')).status).toBe(409);
    expect(await auditEntries('DELIVERY_REJECT')).toHaveLength(1);
  });

  it('checks each line when it is entered', async () => {
    const s = await setup();
    const inactive = await createCategory('Old', 'INACTIVE');
    await createMedicine({ name: 'Taken', categoryId: s.category.id, barcode: '111' });
    const send = (items: object[]) => post(s.cashier.auth, { supplierId: s.supplier.id, items });
    const fields = (res: request.Response) =>
      (
        res.body as { error: { details: { items?: { index: number; field: string }[] } } }
      ).error.details.items?.map((i) => `${i.index}.${i.field}`);

    // A medicine, or a new one, never both or neither.
    expect((await send([{ ...line(s.panadol.id), newMedicine: proposal(s) }])).status).toBe(400);
    expect((await send([{ ...line(''), medicineId: undefined }])).status).toBe(400);

    const expired = await send([line(s.panadol.id, { expiryDate: daysFromToday(0) })]);
    expect(expired.status).toBe(400);
    expect(fields(expired)).toEqual(['0.expiryDate']);

    const clashes = await send([
      line(s.panadol.id),
      { ...line(''), medicineId: undefined, newMedicine: proposal(s, { barcode: '111' }) },
      {
        ...line(''),
        medicineId: undefined,
        newMedicine: proposal(s, { name: 'Other', barcode: null, categoryId: inactive.id }),
      },
    ]);
    expect(clashes.status).toBe(400);
    expect(fields(clashes)).toEqual(['1.newMedicine.barcode', '2.newMedicine.categoryId']);

    // The same new medicine on two lines must be described the same way.
    const mismatch = await send([
      { ...line(''), medicineId: undefined, newMedicine: proposal(s), batchNumber: 'A' },
      {
        ...line(''),
        medicineId: undefined,
        newMedicine: proposal(s, { sellingPrice: '190.00' }),
        batchNumber: 'B',
      },
    ]);
    expect(mismatch.status).toBe(400);
    expect(await prisma.delivery.count()).toBe(0);
  });

  it('approval checks again, and a failed approval changes nothing', async () => {
    const s = await setup();
    const d = await pendingFromCashier(s, [
      line(s.panadol.id),
      { ...line(''), medicineId: undefined, newMedicine: proposal(s) },
    ]);

    // Someone added the medicine to the catalogue in the meantime.
    await createMedicine({ name: 'Calpol', categoryId: s.category.id, barcode: '8964000123456' });
    const taken = await act(s.pharmacist.auth, d.id, 'approve');
    expect(taken.status).toBe(400);

    // And by approval day, the first line's batch has reached its expiry date.
    await prisma.medicine.updateMany({ where: { name: 'Calpol' }, data: { barcode: null } });
    const first = d.items[0]!;
    await prisma.deliveryItem.update({
      where: { id: first.id },
      data: { expiryDate: fromDateOnly(daysFromToday(0)) },
    });
    const expired = await act(s.pharmacist.auth, d.id, 'approve');
    expect(expired.status).toBe(400);

    expect(delivery(await get(s.pharmacist.auth, d.id)).status).toBe('PENDING');
    expect(await prisma.batch.count()).toBe(0);
    expect(await prisma.medicine.count()).toBe(2);
  });
});
