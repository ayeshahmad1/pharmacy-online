import {
  deliveryBodySchema,
  idParamsSchema,
  listDeliveriesQuerySchema,
  rejectDeliveryBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { DELIVERY_APPROVERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './deliveries.controller';

export const deliveriesRouter = Router();

// Every signed-in role can enter a delivery; a cashier's waits for approval
// and cashiers only read (and correct, while pending) the ones they entered
// (the service enforces that). Approving and rejecting is for approvers.
deliveriesRouter.use(authenticate);
const approver = requireRole(...DELIVERY_APPROVERS);

deliveriesRouter.post('/', validate({ body: deliveryBodySchema }), controller.create);
deliveriesRouter.get('/', validate({ query: listDeliveriesQuerySchema }), controller.list);
deliveriesRouter.get('/:id', validate({ params: idParamsSchema }), controller.get);
deliveriesRouter.put(
  '/:id',
  validate({ params: idParamsSchema, body: deliveryBodySchema }),
  controller.update,
);
deliveriesRouter.post(
  '/:id/approve',
  approver,
  validate({ params: idParamsSchema }),
  controller.approve,
);
deliveriesRouter.post(
  '/:id/reject',
  approver,
  validate({ params: idParamsSchema, body: rejectDeliveryBodySchema }),
  controller.reject,
);
