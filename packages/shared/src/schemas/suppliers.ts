import { z } from 'zod';
import type { RecordStatus } from '../constants';
import {
  emailSchema,
  nonEmptyPatch,
  optionalTextSchema,
  paginationQuerySchema,
  recordStatusSchema,
  searchTermSchema,
} from './common';

const supplierNameSchema = z.string().trim().min(1, 'Name is required').max(150);
const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+\-() ]*$/, 'Phone may only contain digits, spaces and + - ( )')
  .transform((s) => (s === '' ? null : s))
  .nullish();
const optionalEmailSchema = z.union([z.literal('').transform(() => null), emailSchema]).nullish();

const supplierFields = {
  contactPerson: optionalTextSchema(100),
  phone: phoneSchema,
  email: optionalEmailSchema,
  address: optionalTextSchema(500),
};

export const createSupplierBodySchema = z.strictObject({
  name: supplierNameSchema,
  ...supplierFields,
});
export type CreateSupplierBody = z.infer<typeof createSupplierBodySchema>;

// Status changes only through the deactivate/activate endpoints.
export const updateSupplierBodySchema = nonEmptyPatch(
  z.strictObject({
    name: supplierNameSchema.optional(),
    ...supplierFields,
  }),
);
export type UpdateSupplierBody = z.infer<typeof updateSupplierBodySchema>;

export const listSuppliersQuerySchema = paginationQuerySchema.extend({
  /** Matches name, contact person or phone. */
  q: searchTermSchema.optional(),
  status: recordStatusSchema.optional(),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;

export type SupplierDto = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: RecordStatus;
  createdAt: string;
  updatedAt: string;
};
