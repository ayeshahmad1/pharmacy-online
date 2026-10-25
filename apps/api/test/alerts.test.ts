import type { AlertDto, AlertSummaryDto, Paginated } from '@pharmacy/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { refreshAlerts } from '../src/modules/alerts/alerts.service';
import { app, auditEntries, createBatch, daysFromToday, resetDatabase } from './helpers';
import { cash, salesSetup, sell } from './sales-fixtures';

beforeEach(resetDatabase);

const get = (auth: string, path: string, query: Record<string, string> = {}) =>
  request(app).get(`/api/alerts${path}`).set('Authorization', auth).query(query);
const post = (auth: string, path: string, body: object = {}) =>
  request(app).post(`/api/alerts${path}`).set('Authorization', auth).send(body);
const alertsOf = (res: request.Response) => (res.body as Paginated<AlertDto>).items;

/**
 * Panadol: reorder level 20, one batch of 8 → LOW_STOCK.
 * Brufen: stocked once, now sold out → OUT_OF_STOCK.
 * Calpol: plenty, but one batch expires in 10 days → EXPIRING_SOON, and an
 * expired batch is still on the shelf → EXPIRED.
 * Never Stocked: no batches at all → nothing.
 */
async function alertSetup() {
  const ctx = await salesSetup();
  const panadol = await ctx.medicine('Panadol');
  await prisma.medicine.update({ where: { id: panadol.id }, data: { reorderLevel: 20 } });
  await ctx.batch(panadol.id, 300, 8);
  const brufen = await ctx.medicine('Brufen');
  await ctx.batch(brufen.id, 300, 2);
  await sell(ctx.pharmacist.auth, {
    items: [{ medicineId: brufen.id, quantity: 2 }],
    payments: [cash('20')],
  }).expect(201);
  const calpol = await ctx.medicine('Calpol');
  await ctx.batch(calpol.id, 300, 100);
  const expiring = await ctx.batch(calpol.id, 10, 5, 'SOON');
  const expired = await ctx.batch(calpol.id, -2, 3, 'GONE');
  await ctx.medicine('Never Stocked');
  return { ...ctx, panadol, brufen, calpol, expiring, expired };
}

describe('refreshAlerts (the alerts job)', () => {
  it('opens one alert per condition and audits the run', async () => {
    const s = await alertSetup();

    const result = await refreshAlerts();

    expect(result).toEqual({ opened: 4, updated: 0, resolved: 0, active: 4 });
    const alerts = await prisma.alert.findMany({ orderBy: { type: 'asc' } });
    expect(alerts.map((a) => [a.type, a.severity, a.openKey])).toEqual([
      ['OUT_OF_STOCK', 'CRITICAL', `OUT_OF_STOCK:${s.brufen.id}`],
      ['LOW_STOCK', 'WARNING', `LOW_STOCK:${s.panadol.id}`],
      ['EXPIRING_SOON', 'WARNING', `EXPIRING_SOON:${s.expiring.id}`],
      ['EXPIRED', 'CRITICAL', `EXPIRED:${s.expired.id}`],
    ]);
    const [entry] = await auditEntries('ALERTS_REFRESH');
    expect(entry).toMatchObject({ userId: null, after: { opened: 4, resolved: 0 } });
  });

  it('does not duplicate alerts or write audit entries when nothing changed', async () => {
    await alertSetup();
    await refreshAlerts();

    expect(await refreshAlerts()).toEqual({ opened: 0, updated: 0, resolved: 0, active: 4 });
    expect(await prisma.alert.count()).toBe(4);
    expect(await auditEntries('ALERTS_REFRESH')).toHaveLength(1);
  });

  it('refreshes numbers, resolves alerts whose condition is gone, and reopens later', async () => {
    const s = await alertSetup();
    await refreshAlerts();

    // Panadol sells down further (update); Calpol's expired batch is written off (resolve).
    await sell(s.pharmacist.auth, {
      items: [{ medicineId: s.panadol.id, quantity: 3 }],
      payments: [cash('30')],
    }).expect(201);
    await request(app)
      .post('/api/inventory/write-offs/expired')
      .set('Authorization', s.pharmacist.auth)
      .send({ batchIds: [s.expired.id] })
      .expect(201);

    expect(await refreshAlerts()).toEqual({ opened: 0, updated: 1, resolved: 1, active: 3 });
    const low = await prisma.alert.findFirstOrThrow({ where: { type: 'LOW_STOCK' } });
    expect(low.message).toContain('5 tablets left');
    const gone = await prisma.alert.findFirstOrThrow({ where: { type: 'EXPIRED' } });
    expect(gone).toMatchObject({ openKey: null, resolvedAt: expect.any(Date) });

    // Panadol restocked above its reorder level: resolved. Sold out later: a new alert.
    const batch = await createBatch({
      medicineId: s.panadol.id,
      supplierId: s.supplier.id,
      userId: s.pharmacist.user.id,
      expiryDate: daysFromToday(200),
      quantity: 50,
    });
    await refreshAlerts();
    expect(await prisma.alert.count({ where: { type: 'LOW_STOCK', resolvedAt: null } })).toBe(0);
    await prisma.stockMovement.create({
      data: {
        batchId: batch.id,
        type: 'ADJUSTMENT',
        quantity: -45,
        reason: 'Count',
        userId: s.pharmacist.user.id,
      },
    });
    await refreshAlerts();
    expect(await prisma.alert.count({ where: { type: 'LOW_STOCK' } })).toBe(2);
  });

  it('escalates low stock to out of stock as a new, unread alert', async () => {
    const s = await alertSetup();
    await refreshAlerts();
    await prisma.alert.updateMany({
      data: { acknowledgedAt: new Date(), acknowledgedById: s.pharmacist.user.id },
    });

    await sell(s.pharmacist.auth, {
      items: [{ medicineId: s.panadol.id, quantity: 8 }],
      payments: [cash('80')],
    }).expect(201);
    await refreshAlerts();

    const panadol = await prisma.alert.findMany({
      where: { medicineId: s.panadol.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(panadol.map((a) => [a.type, a.resolvedAt !== null, a.acknowledgedAt !== null])).toEqual([
      ['LOW_STOCK', true, true],
      ['OUT_OF_STOCK', false, false],
    ]);
  });

  it('turns an expiring batch into an expired one when its day comes', async () => {
    const s = await alertSetup();
    await refreshAlerts();

    const later = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
    const result = await refreshAlerts(null, later);

    expect(result).toMatchObject({ opened: 1, resolved: 1 });
    const alert = await prisma.alert.findFirstOrThrow({
      where: { batchId: s.expiring.id, resolvedAt: null },
    });
    expect(alert.type).toBe('EXPIRED');
  });

  it('skips a run while another holds the lock', async () => {
    await alertSetup();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pharmacy-pos:alerts'))`;
      expect(await refreshAlerts()).toBeNull();
    });
    expect(await prisma.alert.count()).toBe(0);
    expect(await refreshAlerts()).toMatchObject({ opened: 4 });
  });
});

describe('alerts API', () => {
  it('shows alerts and the badge count to every role, critical first', async () => {
    const s = await alertSetup();
    await refreshAlerts();

    const summary = await get(s.cashier.auth, '/summary');
    expect(summary.status).toBe(200);
    expect(summary.body as AlertSummaryDto).toEqual({
      unread: 4,
      active: 4,
      byType: { OUT_OF_STOCK: 1, LOW_STOCK: 1, EXPIRING_SOON: 1, EXPIRED: 1 },
    });

    const list = await get(s.cashier.auth, '');
    expect(list.status).toBe(200);
    expect(alertsOf(list).map((a) => a.severity)).toEqual([
      'CRITICAL',
      'CRITICAL',
      'WARNING',
      'WARNING',
    ]);
    expect(alertsOf(list)[0]).toMatchObject({ status: 'OPEN', acknowledgedBy: null });
    const expired = alertsOf(list).find((a) => a.type === 'EXPIRED')!;
    expect(expired.batch).toEqual({
      id: s.expired.id,
      batchNumber: 'GONE',
      expiryDate: daysFromToday(-2),
    });

    const byType = await get(s.cashier.auth, '', { type: 'LOW_STOCK' });
    expect(alertsOf(byType)).toHaveLength(1);
  });

  it('lets managers acknowledge, once, for everyone', async () => {
    const s = await alertSetup();
    await refreshAlerts();
    const [first] = alertsOf(await get(s.pharmacist.auth, ''));

    expect((await post(s.cashier.auth, `/${first!.id}/acknowledge`)).status).toBe(403);

    const res = await post(s.pharmacist.auth, `/${first!.id}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.alert).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedBy: { id: s.pharmacist.user.id },
    });
    await post(s.pharmacist.auth, `/${first!.id}/acknowledge`).expect(200);
    expect(await auditEntries('ALERT_ACKNOWLEDGE')).toHaveLength(1);

    const summary = (await get(s.cashier.auth, '/summary')).body as AlertSummaryDto;
    expect(summary).toMatchObject({ unread: 3, active: 4 });
    expect(alertsOf(await get(s.cashier.auth, '', { state: 'unread' }))).toHaveLength(3);
    // Acknowledged alerts sort after unread ones.
    expect(alertsOf(await get(s.cashier.auth, '')).at(-1)!.id).toBe(first!.id);
  });

  it('acknowledges all unread alerts, or one type', async () => {
    const s = await alertSetup();
    await refreshAlerts();

    const one = await post(s.pharmacist.auth, '/acknowledge', { type: 'EXPIRED' });
    expect(one.body).toEqual({ acknowledged: 1 });
    const all = await post(s.pharmacist.auth, '/acknowledge');
    expect(all.body).toEqual({ acknowledged: 3 });
    expect(((await get(s.cashier.auth, '/summary')).body as AlertSummaryDto).unread).toBe(0);
    expect((await post(s.cashier.auth, '/acknowledge')).status).toBe(403);
  });

  it('runs a check on demand for managers', async () => {
    const s = await alertSetup();
    expect((await post(s.cashier.auth, '/refresh')).status).toBe(403);
    const res = await post(s.pharmacist.auth, '/refresh');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ opened: 4, updated: 0, resolved: 0, active: 4 });
    const [entry] = await auditEntries('ALERTS_REFRESH');
    expect(entry!.userId).toBe(s.pharmacist.user.id);

    expect(alertsOf(await get(s.cashier.auth, '', { state: 'resolved' }))).toEqual([]);
  });
});
