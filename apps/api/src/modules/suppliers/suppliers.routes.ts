import {
  createSupplierBodySchema,
  idParamsSchema,
  listSuppliersQuerySchema,
  updateSupplierBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { CATALOG_WRITERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './suppliers.controller';

export const suppliersRouter = Router();

// Every signed-in role can read; only catalogue writers can change anything.
suppliersRouter.use(authenticate);
const write = requireRole(...CATALOG_WRITERS);
const byId = validate({ params: idParamsSchema });

suppliersRouter.get('/', validate({ query: listSuppliersQuerySchema }), controller.list);
suppliersRouter.get('/:id', byId, controller.get);
suppliersRouter.post('/', write, validate({ body: createSupplierBodySchema }), controller.create);
suppliersRouter.patch(
  '/:id',
  write,
  validate({ params: idParamsSchema, body: updateSupplierBodySchema }),
  controller.update,
);
suppliersRouter.post('/:id/deactivate', write, byId, controller.deactivate);
suppliersRouter.post('/:id/activate', write, byId, controller.activate);
