import type { SaleDto } from '@pharmacy/shared';
import request from 'supertest';
import { addDays, businessToday, startOfBusinessDay } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { app, createBatch, daysFromToday } from './helpers';
import { createReturn } from './returns-fixtures';
import { card, cash, saleOf, salesSetup, sell, voidSale } from './sales-fixtures';

export function report(auth: string, path: string, query: Record<string, string | number> = {}) {
  return request(app).get(`/api/reports/${path}`).set('Authorization', auth).query(query);
}

/** Moves a sale to another business day (10:00 local time that day). */
export function moveSale(saleId: string, day: string) {
  const at = new Date(startOfBusinessDay(day).getTime() + 10 * 60 * 60 * 1000);
  return prisma.sale.update({ where: { id: saleId }, data: { soldAt: at } });
}

export const today = () => businessToday();
export const yesterday = () => addDays(businessToday(), -1);

/**
 * A known day of trading, all today:
 * - S1, cashier: 4 × Augmentin @25 + 2 × Brufen @10 = 120.00, cash 150 (30 change)
 * - S2, pharmacist: 3 × Augmentin = 75.00 − 10% = 67.50, card
 * - S3, cashier: 1 × Brufen = 10.00 cash, voided by the pharmacist
 * - R1, pharmacist, against S1: 1 Augmentin back on the shelf (25.00) and
 *   1 Brufen damaged (10.00), refunded 35.00 cash
 * Batch costs: Augmentin 15.00, Brufen 4.00.
 */
export async function tradingDay() {
  const ctx = await salesSetup();
  const augmentin = await ctx.medicine('Augmentin 625mg', '25.00');
  const brufen = await ctx.medicine('Brufen 400mg', '10.00');
  const batch = (medicineId: string, costPrice: string) =>
    createBatch({
      medicineId,
      supplierId: ctx.supplier.id,
      userId: ctx.pharmacist.user.id,
      expiryDate: daysFromToday(365),
      quantity: 100,
      costPrice,
    });
  const batchA = await batch(augmentin.id, '15.00');
  const batchB = await batch(brufen.id, '4.00');

  const made = async (res: Promise<request.Response>): Promise<SaleDto> => {
    const r = await res;
    if (r.status !== 201) throw new Error(`Sale failed: ${JSON.stringify(r.body)}`);
    return saleOf(r);
  };
  const s1 = await made(
    sell(ctx.cashier.auth, {
      items: [
        { medicineId: augmentin.id, quantity: 4 },
        { medicineId: brufen.id, quantity: 2 },
      ],
      payments: [cash('150')],
    }),
  );
  const s2 = await made(
    sell(ctx.pharmacist.auth, {
      items: [{ medicineId: augmentin.id, quantity: 3 }],
      discount: { type: 'PERCENT', value: '10' },
      payments: [card('67.50')],
    }),
  );
  const s3 = await made(
    sell(ctx.cashier.auth, {
      items: [{ medicineId: brufen.id, quantity: 1 }],
      payments: [cash('10')],
    }),
  );
  const voided = await voidSale(ctx.pharmacist.auth, s3.id);
  if (voided.status !== 200) throw new Error(`Void failed: ${JSON.stringify(voided.body)}`);

  const lineOf = (sale: SaleDto, medicineId: string) =>
    sale.items.find((i) => i.medicine.id === medicineId)!;
  const r1 = await createReturn(ctx.pharmacist.auth, {
    saleId: s1.id,
    items: [
      { saleItemId: lineOf(s1, augmentin.id).id, quantity: 1, restock: true },
      { saleItemId: lineOf(s1, brufen.id).id, quantity: 1, restock: false },
    ],
  });
  if (r1.status !== 201) throw new Error(`Return failed: ${JSON.stringify(r1.body)}`);

  return {
    ...ctx,
    augmentin,
    brufen,
    batchA,
    batchB,
    s1,
    s2,
    s3,
    returnId: r1.body.return.id as string,
  };
}
