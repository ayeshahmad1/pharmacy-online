import {
  createUserBodySchema,
  idParamsSchema,
  listUsersQuerySchema,
  resetPasswordBodySchema,
  updateUserBodySchema,
} from '@pharmacy/shared';
import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './users.controller';

export const usersRouter = Router();

// User management is ADMIN only.
usersRouter.use(authenticate, requireRole('ADMIN'));

const byId = validate({ params: idParamsSchema });

usersRouter.get('/', validate({ query: listUsersQuerySchema }), controller.list);
usersRouter.post('/', validate({ body: createUserBodySchema }), controller.create);
usersRouter.get('/:id', byId, controller.get);
usersRouter.patch(
  '/:id',
  validate({ params: idParamsSchema, body: updateUserBodySchema }),
  controller.update,
);
usersRouter.post('/:id/deactivate', byId, controller.deactivate);
usersRouter.post('/:id/activate', byId, controller.activate);
usersRouter.post(
  '/:id/reset-password',
  validate({ params: idParamsSchema, body: resetPasswordBodySchema }),
  controller.resetPassword,
);
