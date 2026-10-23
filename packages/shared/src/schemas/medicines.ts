import { z } from 'zod';
import type { RecordStatus } from '../constants';
import {
  moneySchema,
  nonEmptyPatch,
  optionalTextSchema,
  paginationQuerySchema,
  recordStatusSchema,
  searchTermSchema,
} from './common';

const medicineNameSchema = z.string().trim().min(1, 'Name is required').max(200);

/** What a scanner types: printable ASCII, no spaces. Blank means "no barcode". */
const barcodeSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[\x21-\x7E]*$/, 'Barcode may only contain letters, digits and symbols, no spaces')
  .transform((s) => (s === '' ? null : s))
  .nullish();

/** e.g. "tablet", "strip", "bottle". Stored lowercase so filters and reports group cleanly. */
const unitSchema = z.string().trim().toLowerCase().min(1, 'Unit is required').max(30);

const reorderLevelSchema = z.number().int().min(0).max(1_000_000);

export const createMedicineBodySchema = z.strictObject({
  name: medicineNameSchema,
  genericName: optionalTextSchema(200),
  barcode: barcodeSchema,
  categoryId: z.uuid(),
  unit: unitSchema,
  reorderLevel: reorderLevelSchema.default(0),
  /** Price per `unit`, PKR, as a decimal string. */
  sellingPrice: moneySchema,
});
export type CreateMedicineBody = z.infer<typeof createMedicineBodySchema>;

// Status changes only through the deactivate/activate endpoints.
export const updateMedicineBodySchema = nonEmptyPatch(
  z.strictObject({
    name: medicineNameSchema.optional(),
    genericName: optionalTextSchema(200),
    barcode: barcodeSchema,
    categoryId: z.uuid().optional(),
    unit: unitSchema.optional(),
    reorderLevel: reorderLevelSchema.optional(),
    sellingPrice: moneySchema.optional(),
  }),
);
export type UpdateMedicineBody = z.infer<typeof updateMedicineBodySchema>;

export const listMedicinesQuerySchema = paginationQuerySchema.extend({
  /**
   * Matches the brand name or the generic/salt name (case-insensitive
   * substring). Results are ranked: exact name, name prefix, generic prefix,
   * then everything else, each alphabetically.
   */
  q: searchTermSchema.optional(),
  categoryId: z.uuid().optional(),
  status: recordStatusSchema.optional(),
});
export type ListMedicinesQuery = z.infer<typeof listMedicinesQuerySchema>;

export type MedicineDto = {
  id: string;
  name: string;
  genericName: string | null;
  barcode: string | null;
  category: { id: string; name: string };
  unit: string;
  reorderLevel: number;
  /** PKR, always two decimal places, e.g. "120.50". */
  sellingPrice: string;
  status: RecordStatus;
  createdAt: string;
  updatedAt: string;
};
