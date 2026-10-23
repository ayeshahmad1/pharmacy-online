import {
  createReturnBodySchema,
  idParamsSchema,
  listReturnsQuerySchema,
  rejectReturnBodySchema,
  returnableQuerySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { RETURN_APPROVERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './returns.controller';

export const returnsRouter = Router();

// Every signed-in role can raise a return against any sale; a cashier's waits
// for approval and cashiers only read the returns they raised (the service
// enforces that). Approving and rejecting is for return approvers.
returnsRouter.use(authenticate);

returnsRouter.get('/returnable', validate({ query: returnableQuerySchema }), controller.returnable);
returnsRouter.post('/', validate({ body: createReturnBodySchema }), controller.create);
returnsRouter.get('/', validate({ query: listReturnsQuerySchema }), controller.list);
returnsRouter.get('/:id', validate({ params: idParamsSchema }), controller.get);
returnsRouter.post(
  '/:id/approve',
  requireRole(...RETURN_APPROVERS),
  validate({ params: idParamsSchema }),
  controller.approve,
);
returnsRouter.post(
  '/:id/reject',
  requireRole(...RETURN_APPROVERS),
  validate({ params: idParamsSchema, body: rejectReturnBodySchema }),
  controller.reject,
);
