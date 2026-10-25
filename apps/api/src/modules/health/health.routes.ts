import { Router } from 'express';
import * as controller from './health.controller';

export const healthRouter = Router();

// Public and unauthenticated, for PM2/uptime monitors and the deploy script.
// They reveal no data: only whether the API and its database answer.
healthRouter.get('/', controller.live);
healthRouter.get('/ready', controller.ready);
