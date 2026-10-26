import {
  adjustStockBodySchema,
  createMedicineBodySchema,
  createSupplierBodySchema,
  receiveStockBodySchema,
} from '@pharmacy/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { intInput, parseForm, serverFieldErrors } from './form';

const categoryId = '7d3b1a0e-8a8f-4c8e-9d0a-1f2e3d4c5b6a';
const medicineId = '0b9f7f52-2f1b-4d8f-8b7a-6a5c4d3e2f10';
const supplierId = 'e2a1c3b4-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('parseForm', () => {
  it('returns the parsed data when the form is valid', () => {
    const result = parseForm(createMedicineBodySchema, {
      name: ' Panadol ',
      genericName: '',
      barcode: '',
      categoryId,
      unit: 'Tablet',
      reorderLevel: intInput(''),
      sellingPrice: '2.50',
    });
    expect(result).toEqual({
      ok: true,
      data: {
        name: 'Panadol',
        genericName: null,
        barcode: null,
        categoryId,
        unit: 'tablet',
        reorderLevel: 0,
        sellingPrice: '2.50',
      },
    });
  });

  it('keeps the schema messages and replaces zod defaults with plain ones', () => {
    const result = parseForm(createMedicineBodySchema, {
      name: '',
      categoryId: '',
      unit: 'tablet',
      reorderLevel: intInput('2.5'),
      sellingPrice: '1.999',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'Name is required',
        categoryId: 'Required',
        reorderLevel: 'Enter a whole number',
        sellingPrice: 'Must be an amount like "120" or "120.50"',
      },
    });
  });

  it('keys line-item errors by their path', () => {
    const line = { medicineId, batchNumber: 'B1', expiryDate: '2030-01-01', costPrice: '5' };
    const result = parseForm(receiveStockBodySchema, {
      supplierId,
      items: [
        { ...line, quantity: 10 },
        { ...line, quantity: intInput('') },
      ],
    });
    expect(result).toEqual({ ok: false, errors: { 'items.1.quantity': 'Required' } });

    // The duplicate-batch check only runs once every line is otherwise valid.
    const duplicate = parseForm(receiveStockBodySchema, {
      supplierId,
      items: [
        { ...line, quantity: 10 },
        { ...line, batchNumber: 'b1', quantity: 5 },
      ],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      errors: { 'items.1.batchNumber': expect.stringMatching(/appears twice/) as unknown },
    });
  });

  it('reports limits in words', () => {
    const result = parseForm(adjustStockBodySchema, {
      batchId: medicineId,
      quantity: 2_000_000,
      reason: 'ok',
    });
    expect(result).toEqual({
      ok: false,
      errors: { quantity: 'Must be at most 1000000', reason: 'Give a reason for the adjustment' },
    });
  });

  it('accepts a blank optional email', () => {
    expect(parseForm(createSupplierBodySchema, { name: 'Ali Traders', email: '' })).toMatchObject({
      ok: true,
      data: { email: null },
    });
  });

  it('says plainly when an email is not valid', () => {
    expect(parseForm(createSupplierBodySchema, { name: 'Ali Traders', email: 'ali@' })).toEqual({
      ok: false,
      errors: { email: 'Enter a valid email address' },
    });
  });
});

describe('intInput', () => {
  it('turns form text into a number only when it is a whole number', () => {
    expect(intInput(' 12 ')).toBe(12);
    expect(intInput('-3')).toBe(-3);
    expect(intInput('')).toBeUndefined();
    expect(intInput('1e3')).toBe('1e3');
  });
});

describe('serverFieldErrors', () => {
  it('reads flattened validation errors', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', {
      body: { formErrors: [], fieldErrors: { name: ['Name is required'] } },
    });
    expect(serverFieldErrors(err)).toEqual({ name: 'Name is required' });
  });

  it('reads a single-field conflict', () => {
    const err = new ApiError(409, 'CONFLICT', 'Barcode is already used by "Panadol"', {
      field: 'barcode',
    });
    expect(serverFieldErrors(err)).toEqual({ barcode: 'Barcode is already used by "Panadol"' });
  });

  it('reads per-line receipt errors', () => {
    const err = new ApiError(400, 'BAD_REQUEST', 'Some items cannot be received', {
      items: [{ index: 1, field: 'expiryDate', message: 'Expiry date is not after today' }],
    });
    expect(serverFieldErrors(err)).toEqual({
      'items.1.expiryDate': 'Expiry date is not after today',
    });
  });

  it('ignores errors without field details', () => {
    expect(serverFieldErrors(new Error('boom'))).toEqual({});
    expect(serverFieldErrors(new ApiError(0, 'NETWORK_ERROR', 'offline'))).toEqual({});
  });
});
