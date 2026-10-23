import { z } from 'zod';
import type { RecordStatus } from '../constants';
import {
  nonEmptyPatch,
  optionalTextSchema,
  paginationQuerySchema,
  recordStatusSchema,
  searchTermSchema,
} from './common';

const categoryNameSchema = z.string().trim().min(1, 'Name is required').max(100);

export const createCategoryBodySchema = z.strictObject({
  name: categoryNameSchema,
  description: optionalTextSchema(500),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

// Status changes only through the deactivate/activate endpoints.
export const updateCategoryBodySchema = nonEmptyPatch(
  z.strictObject({
    name: categoryNameSchema.optional(),
    description: optionalTextSchema(500),
  }),
);
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

export const listCategoriesQuerySchema = paginationQuerySchema.extend({
  /** Matches the category name. */
  q: searchTermSchema.optional(),
  status: recordStatusSchema.optional(),
});
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;

export type CategoryDto = {
  id: string;
  name: string;
  description: string | null;
  status: RecordStatus;
  createdAt: string;
  updatedAt: string;
};
