import type {
  CreateUserBody,
  IdParams,
  ListUsersQuery,
  ResetPasswordBody,
  UpdateUserBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { requestMeta } from '../../lib/audit';
import * as usersService from './users.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const actor = (req: Request): usersService.Actor => ({ id: req.user!.id, meta: requestMeta(req) });
const params = (req: Request) => req.params as IdParams;

export const list: RequestHandler = async (req, res) => {
  res.json(await usersService.listUsers(req.query as unknown as ListUsersQuery));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ user: await usersService.getUser(params(req).id) });
};

export const create: RequestHandler = async (req, res) => {
  const user = await usersService.createUser(req.body as CreateUserBody, actor(req));
  res.status(201).json({ user });
};

export const update: RequestHandler = async (req, res) => {
  const user = await usersService.updateUser(
    params(req).id,
    req.body as UpdateUserBody,
    actor(req),
  );
  res.json({ user });
};

export const deactivate: RequestHandler = async (req, res) => {
  res.json({ user: await usersService.deactivateUser(params(req).id, actor(req)) });
};

export const activate: RequestHandler = async (req, res) => {
  res.json({ user: await usersService.activateUser(params(req).id, actor(req)) });
};

export const resetPassword: RequestHandler = async (req, res) => {
  const { newPassword } = req.body as ResetPasswordBody;
  await usersService.resetPassword(params(req).id, newPassword, actor(req));
  res.status(204).end();
};
