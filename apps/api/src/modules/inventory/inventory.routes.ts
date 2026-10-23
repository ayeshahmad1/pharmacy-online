import {
  adjustStockBodySchema,
  expiredStockQuerySchema,
  expiringStockQuerySchema,
  idParamsSchema,
  listMovementsQuerySchema,
  listStockQuerySchema,
  lowStockQuerySchema,
  medicineStockQuerySchema,
  receiveStockBodySchema,
  sellableSearchQuerySchema,
  writeOffExpiredBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { INVENTORY_MANAGERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './inventory.controller';

export const inventoryRouter = Router();

// Every signed-in role can look up stock levels (billing needs them; cost
// prices are hidden from cashiers). Changing stock and the inventory reports
// are for inventory managers only.
inventoryRouter.use(authenticate);
const manage = requireRole(...INVENTORY_MANAGERS);

inventoryRouter.get('/stock', validate({ query: listStockQuerySchema }), controller.listStock);
inventoryRouter.get(
  '/medicines/:id/stock',
  validate({ params: idParamsSchema, query: medicineStockQuerySchema }),
  controller.medicineStock,
);
// Billing lookups: price and sellable stock together, for every role.
inventoryRouter.get(
  '/sellable',
  validate({ query: sellableSearchQuerySchema }),
  controller.searchSellable,
);
inventoryRouter.get('/sellable/:id', validate({ params: idParamsSchema }), controller.getSellable);
inventoryRouter.get(
  '/medicines/:id/substitutes',
  validate({ params: idParamsSchema }),
  controller.substitutes,
);
inventoryRouter.get('/batches/:id', validate({ params: idParamsSchema }), controller.getBatch);

inventoryRouter.get(
  '/low-stock',
  manage,
  validate({ query: lowStockQuerySchema }),
  controller.lowStock,
);
inventoryRouter.get(
  '/expiring',
  manage,
  validate({ query: expiringStockQuerySchema }),
  controller.expiring,
);
inventoryRouter.get(
  '/expired',
  manage,
  validate({ query: expiredStockQuerySchema }),
  controller.expired,
);
inventoryRouter.get(
  '/movements',
  manage,
  validate({ query: listMovementsQuerySchema }),
  controller.movements,
);

inventoryRouter.post(
  '/receipts',
  manage,
  validate({ body: receiveStockBodySchema }),
  controller.receive,
);
inventoryRouter.post(
  '/adjustments',
  manage,
  validate({ body: adjustStockBodySchema }),
  controller.adjust,
);
inventoryRouter.post(
  '/write-offs/expired',
  manage,
  validate({ body: writeOffExpiredBodySchema }),
  controller.writeOffExpired,
);
