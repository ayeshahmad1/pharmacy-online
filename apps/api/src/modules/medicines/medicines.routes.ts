import {
  createMedicineBodySchema,
  idParamsSchema,
  listMedicinesQuerySchema,
  updateMedicineBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { CATALOG_WRITERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './medicines.controller';

export const medicinesRouter = Router();

// Every signed-in role can read; only catalogue writers can change anything.
medicinesRouter.use(authenticate);
const write = requireRole(...CATALOG_WRITERS);
const byId = validate({ params: idParamsSchema });

medicinesRouter.get('/', validate({ query: listMedicinesQuerySchema }), controller.list);
medicinesRouter.get('/:id', byId, controller.get);
medicinesRouter.post('/', write, validate({ body: createMedicineBodySchema }), controller.create);
medicinesRouter.patch(
  '/:id',
  write,
  validate({ params: idParamsSchema, body: updateMedicineBodySchema }),
  controller.update,
);
medicinesRouter.post('/:id/deactivate', write, byId, controller.deactivate);
medicinesRouter.post('/:id/activate', write, byId, controller.activate);
