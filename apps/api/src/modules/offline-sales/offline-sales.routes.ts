import {
  dismissOfflineConflictBodySchema,
  idParamsSchema,
  listOfflineConflictsQuerySchema,
  reportOfflineConflictBodySchema,
  retryOfflineConflictBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { SALE_MANAGERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './offline-sales.controller';

export const offlineSalesRouter = Router();

// Every signed-in role reports its own refused offline sales and reads them
// (cashiers only their own; the service enforces that). Saving or dismissing
// one is for sale managers.
offlineSalesRouter.use(authenticate);

offlineSalesRouter.post(
  '/conflicts',
  validate({ body: reportOfflineConflictBodySchema }),
  controller.report,
);
offlineSalesRouter.get(
  '/conflicts',
  validate({ query: listOfflineConflictsQuerySchema }),
  controller.list,
);
offlineSalesRouter.get('/conflicts/:id', validate({ params: idParamsSchema }), controller.get);
offlineSalesRouter.post(
  '/conflicts/:id/retry',
  requireRole(...SALE_MANAGERS),
  validate({ params: idParamsSchema, body: retryOfflineConflictBodySchema }),
  controller.retry,
);
offlineSalesRouter.post(
  '/conflicts/:id/dismiss',
  requireRole(...SALE_MANAGERS),
  validate({ params: idParamsSchema, body: dismissOfflineConflictBodySchema }),
  controller.dismiss,
);
