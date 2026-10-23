import { loginBodySchema } from '@pharmacy/shared';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './auth.controller';

export const authRouter = Router();

authRouter.post('/login', validate({ body: loginBodySchema }), controller.login);
// Refresh and logout authenticate with the refresh cookie, not the access
// token, so they still work after the access token has expired.
authRouter.post('/refresh', controller.refresh);
authRouter.post('/logout', controller.logout);
authRouter.get('/me', authenticate, controller.me);
