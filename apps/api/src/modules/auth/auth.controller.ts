import type { AuthResponse, LoginBody } from '@pharmacy/shared';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { requestMeta } from '../../lib/audit';
import { config } from '../../lib/config';
import { AppError } from '../../lib/errors';
import * as usersService from '../users/users.service';
import * as authService from './auth.service';

export const REFRESH_COOKIE = 'pharmacy_rt';

// httpOnly keeps the refresh token away from page scripts; the path limits it
// to the auth endpoints; SameSite=Strict blocks cross-site refresh/logout.
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'strict',
  path: '/api/auth',
};

function sendAuthResult(res: Response, result: authService.AuthResult) {
  res.cookie(REFRESH_COOKIE, result.refreshToken, {
    ...refreshCookieOptions,
    expires: result.refreshTokenExpiresAt,
  });
  const body: AuthResponse = {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    user: result.user,
  };
  res.json(body);
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const login: RequestHandler = async (req, res) => {
  const result = await authService.login(req.body as LoginBody, requestMeta(req));
  sendAuthResult(res, result);
};

export const refresh: RequestHandler = async (req, res) => {
  const token = readRefreshCookie(req);
  if (!token) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session expired, please log in again');
  }
  try {
    sendAuthResult(res, await authService.refresh(token, requestMeta(req)));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    throw err;
  }
};

export const logout: RequestHandler = async (req, res) => {
  await authService.logout(readRefreshCookie(req), requestMeta(req));
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
  res.status(204).end();
};

export const me: RequestHandler = async (req, res) => {
  const user = await usersService.getUser(req.user!.id);
  res.json({ user });
};
