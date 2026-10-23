import { z } from 'zod';

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
