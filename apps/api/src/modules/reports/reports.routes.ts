import {
  cashClosingQuerySchema,
  deadStockQuerySchema,
  expiryReportQuerySchema,
  lowStockReportQuerySchema,
  medicineReportQuerySchema,
  reportRangeQuerySchema,
  salesReportQuerySchema,
  supplierPurchasesQuerySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { REPORT_VIEWERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './reports.controller';

export const reportsRouter = Router();

// Reports show every cashier's takings, cost prices and profit: managers only.
reportsRouter.use(authenticate, requireRole(...REPORT_VIEWERS));

reportsRouter.get('/dashboard', controller.dashboard);
reportsRouter.get('/sales', validate({ query: salesReportQuerySchema }), controller.sales);
reportsRouter.get(
  '/medicines',
  validate({ query: medicineReportQuerySchema }),
  controller.medicines,
);
reportsRouter.get('/dead-stock', validate({ query: deadStockQuerySchema }), controller.deadStock);
reportsRouter.get('/expiry', validate({ query: expiryReportQuerySchema }), controller.expiry);
reportsRouter.get(
  '/low-stock',
  validate({ query: lowStockReportQuerySchema }),
  controller.lowStock,
);
reportsRouter.get(
  '/supplier-purchases',
  validate({ query: supplierPurchasesQuerySchema }),
  controller.supplierPurchases,
);
reportsRouter.get('/cashiers', validate({ query: reportRangeQuerySchema }), controller.cashiers);
reportsRouter.get(
  '/cash-closing',
  validate({ query: cashClosingQuerySchema }),
  controller.cashClosing,
);
