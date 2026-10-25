import {
  acknowledgeAlertsBodySchema,
  idParamsSchema,
  listAlertsQuerySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { ALERT_MANAGERS, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './alerts.controller';

export const alertsRouter = Router();

// Every signed-in role sees alerts (and the badge); only managers clear
// them or run a check on demand. Alerts never carry cost prices.
alertsRouter.use(authenticate);
const manage = requireRole(...ALERT_MANAGERS);

alertsRouter.get('/', validate({ query: listAlertsQuerySchema }), controller.list);
alertsRouter.get('/summary', controller.summary);
alertsRouter.post(
  '/acknowledge',
  manage,
  validate({ body: acknowledgeAlertsBodySchema }),
  controller.acknowledgeAll,
);
alertsRouter.post('/refresh', manage, controller.refresh);
alertsRouter.post(
  '/:id/acknowledge',
  manage,
  validate({ params: idParamsSchema }),
  controller.acknowledge,
);
