import {
  createCategoryBodySchema,
  idParamsSchema,
  listCategoriesQuerySchema,
  updateCategoryBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { CATALOG_WRITERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './categories.controller';

export const categoriesRouter = Router();

// Every signed-in role can read; only catalogue writers can change anything.
categoriesRouter.use(authenticate);
const write = requireRole(...CATALOG_WRITERS);
const byId = validate({ params: idParamsSchema });

categoriesRouter.get('/', validate({ query: listCategoriesQuerySchema }), controller.list);
categoriesRouter.get('/:id', byId, controller.get);
categoriesRouter.post('/', write, validate({ body: createCategoryBodySchema }), controller.create);
categoriesRouter.patch(
  '/:id',
  write,
  validate({ params: idParamsSchema, body: updateCategoryBodySchema }),
  controller.update,
);
categoriesRouter.post('/:id/deactivate', write, byId, controller.deactivate);
categoriesRouter.post('/:id/activate', write, byId, controller.activate);
