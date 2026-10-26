import { createReturnBodySchema, type ReturnableLineDto } from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { parseForm } from '@/lib/form';
import {
  batchExpired,
  checkSplit,
  defaultSplit,
  draftQuantity,
  emptyDrafts,
  lineRefund,
  planReturn,
  returnErrorFields,
  splitDrafts,
} from './return-lines';

const today = new Date(2026, 9, 26, 15, 0);
const SALE_ID = '5c1f2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const LINE_A = '0b9f7f52-2f1b-4d8f-8b7a-6a5c4d3e2f10';
const LINE_B = '7d3b1a0e-8a8f-4c8e-9d0a-1f2e3d4c5b6a';

const line = (over: Partial<ReturnableLineDto>): ReturnableLineDto => ({
  id: LINE_A,
  medicine: { id: 'm1', name: 'Augmentin 625mg', genericName: null, unit: 'tablet' },
  batch: { id: 'b1', batchNumber: 'A', expiryDate: '2027-06-30' },
  quantity: 3,
  unitPrice: '10.00',
  discount: '0.00',
  tax: '0.00',
  lineTotal: '10.00',
  returnedQuantity: 0,
  pendingQuantity: 0,
  returnableQuantity: 3,
  refundableAmount: '10.00',
  ...over,
});

describe('lineRefund (mirrors the API)', () => {
  // 3 units paid 10.00 in total (a discount made the unit price uneven).
  const l = line({});

  it('refunds pro rata, rounded down to the paisa', () => {
    expect(lineRefund(l, 1)).toBe(333n);
    expect(lineRefund(l, 2)).toBe(666n);
  });

  it('gives the return taking the last units whatever is left, so the line refunds exactly', () => {
    expect(lineRefund(l, 3)).toBe(1000n);
    // One unit already refunded 3.33: the last two get 6.67, not 6.66.
    const afterOne = line({ returnedQuantity: 1, returnableQuantity: 2, refundableAmount: '6.67' });
    expect(lineRefund(afterOne, 2)).toBe(667n);
    expect(lineRefund(afterOne, 1)).toBe(333n);
  });

  it('is zero for nothing', () => {
    expect(lineRefund(l, 0)).toBe(0n);
  });
});

describe('draftQuantity', () => {
  it('reads blank as none and whole numbers as themselves', () => {
    expect(draftQuantity('')).toBe(0);
    expect(draftQuantity(' 2 ')).toBe(2);
    expect(draftQuantity('1.5')).toBeNull();
    expect(draftQuantity('-1')).toBeNull();
    expect(draftQuantity('two')).toBeNull();
  });
});

describe('planReturn', () => {
  const lines = [
    line({}),
    line({
      id: LINE_B,
      batch: { id: 'b2', batchNumber: 'B', expiryDate: '2026-10-26' },
      quantity: 7,
      lineTotal: '175.00',
      pendingQuantity: 2,
      returnableQuantity: 5,
      refundableAmount: '125.00',
    }),
  ];

  it('defaults restock off for a batch that expires today or earlier', () => {
    expect(batchExpired(lines[0]!, today)).toBe(false);
    expect(batchExpired(lines[1]!, today)).toBe(true);
    expect(emptyDrafts(lines, today)).toEqual({
      [LINE_A]: { quantity: '', restock: true },
      [LINE_B]: { quantity: '', restock: false },
    });
  });

  it('collects the lines being returned with their refunds and a body the schema accepts', () => {
    const plan = planReturn(
      lines,
      { [LINE_A]: { quantity: '1', restock: false }, [LINE_B]: { quantity: '5', restock: true } },
      today,
    );
    expect(plan.errors).toEqual({});
    expect(plan.items).toEqual([
      { saleItemId: LINE_A, quantity: 1, restock: false },
      // Expired: never restocked, whatever was ticked.
      { saleItemId: LINE_B, quantity: 5, restock: false },
    ]);
    expect(plan.refunds).toEqual({ [LINE_A]: 333n, [LINE_B]: 12500n });
    expect(plan.total).toBe(12833n);
    expect(plan.units).toBe(6);

    const parsed = parseForm(createReturnBodySchema, {
      saleId: SALE_ID,
      items: plan.items,
      reason: 'Unopened',
    });
    expect(parsed.ok).toBe(true);
  });

  it('flags quantities that are not whole numbers or more than can come back', () => {
    const plan = planReturn(
      [...lines, line({ id: 'c', returnableQuantity: 0 })],
      {
        [LINE_A]: { quantity: '4', restock: true },
        [LINE_B]: { quantity: '2.5', restock: true },
        c: { quantity: '1', restock: true },
      },
      today,
    );
    expect(plan.items).toEqual([]);
    expect(plan.errors).toEqual({
      [`line.${LINE_A}`]: 'At most 3 can come back',
      [`line.${LINE_B}`]: 'Enter a whole number',
      'line.c': 'Nothing left to return on this line',
    });
  });

  it('leaves blank lines out, so an empty form has no items', () => {
    const plan = planReturn(lines, emptyDrafts(lines, today), today);
    expect(plan.items).toEqual([]);
    expect(plan.total).toBe(0n);
    const parsed = parseForm(createReturnBodySchema, {
      saleId: SALE_ID,
      items: plan.items,
      reason: 'Unopened',
    });
    expect(parsed).toEqual({ ok: false, errors: { items: 'Add at least one item' } });
  });
});

describe('refund split', () => {
  const refundable = [
    { method: 'CASH' as const, paid: '150.00', available: '75.00' },
    { method: 'CARD' as const, paid: '100.00', available: '100.00' },
    { method: 'MOBILE_WALLET' as const, paid: '20.00', available: '0.00' },
  ];

  it('defaults to cash first, then card, then wallet, each up to what it can refund', () => {
    expect(defaultSplit(5000n, refundable)).toEqual([{ method: 'CASH', amount: 5000n }]);
    expect(defaultSplit(12000n, refundable)).toEqual([
      { method: 'CASH', amount: 7500n },
      { method: 'CARD', amount: 4500n },
    ]);
  });

  it('offers only methods that can still refund, prefilled with the default', () => {
    expect(splitDrafts(12000n, refundable)).toEqual([
      { method: 'CASH', amount: '75.00', reference: '' },
      { method: 'CARD', amount: '45.00', reference: '' },
    ]);
    expect(splitDrafts(1000n, refundable)).toEqual([
      { method: 'CASH', amount: '10.00', reference: '' },
      { method: 'CARD', amount: '', reference: '' },
    ]);
  });

  it('accepts a split that adds up and stays within each method', () => {
    const check = checkSplit(12000n, refundable, [
      { method: 'CASH', amount: '20', reference: '' },
      { method: 'CARD', amount: '100', reference: ' AUTH-9 ' },
    ]);
    expect(check).toMatchObject({ ok: true, entered: 12000n, error: null });
    expect(check.refunds).toEqual([
      { method: 'CASH', amount: '20.00' },
      { method: 'CARD', amount: '100.00', reference: 'AUTH-9' },
    ]);
    const parsed = parseForm(createReturnBodySchema, {
      saleId: SALE_ID,
      items: [{ saleItemId: LINE_A, quantity: 1 }],
      reason: 'Unopened',
      refunds: check.refunds,
    });
    expect(parsed.ok).toBe(true);
  });

  it('refuses more than a method can refund, bad amounts, and a total that does not match', () => {
    expect(
      checkSplit(12000n, refundable, [
        { method: 'CASH', amount: '80', reference: '' },
        { method: 'CARD', amount: 'abc', reference: '' },
      ]),
    ).toMatchObject({
      ok: false,
      // The over-limit cash still counts toward what the split adds up to.
      entered: 8000n,
      fieldErrors: {
        CASH: 'At most Rs 75.00 can go back by cash',
        CARD: 'Enter an amount like "120" or "120.50"',
      },
    });
    expect(
      checkSplit(12000n, refundable, [{ method: 'CASH', amount: '75', reference: '' }]),
    ).toMatchObject({
      ok: false,
      entered: 7500n,
      error: 'The split adds up to Rs 75.00; the refund due is Rs 120.00',
    });
  });
});

describe('returnErrorFields', () => {
  const sent = {
    items: [{ saleItemId: LINE_A }, { saleItemId: LINE_B }],
    refunds: [{ method: 'CASH' as const }, { method: 'CARD' as const }],
  };

  it('puts "more than can still be returned" on the line it concerns', () => {
    const err = new ApiError(409, 'CONFLICT', 'Only 2 of 7 can still be returned', {
      items: [{ index: 1, saleItemId: LINE_B, requested: 3, sold: 7, returnable: 2 }],
    });
    expect(returnErrorFields(err, sent)).toEqual({
      [`line.${LINE_B}`]: 'Only 2 can still be returned',
    });
  });

  it('maps refund method issues, a split that does not add up, and field errors', () => {
    const refunds = new ApiError(400, 'BAD_REQUEST', 'Some refunds are not allowed', {
      refunds: [{ index: 1, field: 'amount', message: 'At most 45.00 can be refunded by card' }],
    });
    expect(returnErrorFields(refunds, sent)).toEqual({
      'refund.CARD': 'At most 45.00 can be refunded by card',
    });

    const total = new ApiError(400, 'BAD_REQUEST', 'Refunds add up to 10.00 but…', {
      field: 'refunds',
    });
    expect(returnErrorFields(total, sent)).toEqual({ refunds: 'Refunds add up to 10.00 but…' });

    const validation = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', {
      body: { fieldErrors: { reason: ['Give a reason for the return'] } },
    });
    expect(returnErrorFields(validation, sent)).toEqual({
      reason: 'Give a reason for the return',
    });
  });

  it('has nothing to map for other errors', () => {
    expect(returnErrorFields(new Error('boom'), sent)).toEqual({});
    expect(returnErrorFields(new ApiError(409, 'CONFLICT', 'Sale is voided'), sent)).toEqual({});
  });
});
