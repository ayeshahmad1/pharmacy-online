import type {
  CreateReturnBody,
  IdParams,
  ListReturnsQuery,
  RejectReturnBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './returns.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;
const viewer = (req: Request): service.Viewer => ({ id: req.user!.id, role: req.user!.role });
const staff = (req: Request): service.Staff => ({ ...actor(req), role: req.user!.role });

/** 201 whether the return completed at once or is waiting for approval; see `status`. */
export const create: RequestHandler = async (req, res) => {
  const ret = await service.createReturn(req.body as CreateReturnBody, staff(req));
  res.status(201).json({ return: ret });
};

export const approve: RequestHandler = async (req, res) => {
  res.json({ return: await service.approveReturn(params(req).id, actor(req)) });
};

export const reject: RequestHandler = async (req, res) => {
  const ret = await service.rejectReturn(params(req).id, req.body as RejectReturnBody, actor(req));
  res.json({ return: ret });
};

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listReturns(req.query as unknown as ListReturnsQuery, viewer(req)));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ return: await service.getReturn(params(req).id, viewer(req)) });
};

export const returnable: RequestHandler = async (req, res) => {
  res.json(await service.getReturnable(req.query));
};
