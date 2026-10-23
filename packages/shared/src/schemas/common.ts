import { z } from 'zod';
import { RECORD_STATUSES } from '../constants';

export const idParamsSchema = z.object({ id: z.uuid() });
export type IdParams = z.infer<typeof idParamsSchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

/** Free-text search term for list endpoints (case-insensitive substring). */
export const searchTermSchema = z.string().trim().min(1).max(100);

export const recordStatusSchema = z.enum(RECORD_STATUSES);

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email('Invalid email'));

/**
 * Money in PKR as a decimal string with at most 2 decimal places, e.g. "120"
 * or "120.50". Numbers are rejected on purpose: JS floats must never carry
 * money (CLAUDE.md rule 6). Fits Postgres Decimal(12,2).
 */
export const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Must be an amount like "120" or "120.50"');

/**
 * Optional text field. Blank strings become null, so a client can clear a
 * field by sending "" or null; undefined means "not provided".
 */
export const optionalTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullish();

/** Wraps a PATCH body schema so an update with no fields is rejected. */
export function nonEmptyPatch<T extends z.ZodObject>(schema: T) {
  return schema.refine((b) => Object.values(b as object).some((v) => v !== undefined), {
    message: 'Provide at least one field to update',
  });
}
