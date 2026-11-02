import { listLegacyPurchasesQuerySchema, listLegacyReturnsQuerySchema } from '@pharmacy/shared';
import { Router } from 'express';
import { LEGACY_VIEWERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './legacy.controller';

export const legacyRouter = Router();

// Read-only history loaded from the old system; nothing here can be changed.
legacyRouter.use(authenticate, requireRole(...LEGACY_VIEWERS));

legacyRouter.get(
  '/purchases',
  validate({ query: listLegacyPurchasesQuerySchema }),
  controller.listPurchases,
);
legacyRouter.get(
  '/returns',
  validate({ query: listLegacyReturnsQuerySchema }),
  controller.listReturns,
);
