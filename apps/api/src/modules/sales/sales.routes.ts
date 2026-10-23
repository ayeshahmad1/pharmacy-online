import {
  createSaleBodySchema,
  idParamsSchema,
  listSalesQuerySchema,
  voidSaleBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { SALE_MANAGERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './sales.controller';

export const salesRouter = Router();

// Every signed-in role can sell and read sales (cashiers only their own; the
// service enforces that). Voiding is for sale managers.
salesRouter.use(authenticate);

salesRouter.post('/', validate({ body: createSaleBodySchema }), controller.create);
salesRouter.get('/', validate({ query: listSalesQuerySchema }), controller.list);
salesRouter.get('/:id', validate({ params: idParamsSchema }), controller.get);
salesRouter.post(
  '/:id/void',
  requireRole(...SALE_MANAGERS),
  validate({ params: idParamsSchema, body: voidSaleBodySchema }),
  controller.voidSale,
);
