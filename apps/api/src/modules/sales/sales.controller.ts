import type { CreateSaleBody, IdParams, ListSalesQuery, VoidSaleBody } from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './sales.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;
const viewer = (req: Request): service.Viewer => ({ id: req.user!.id, role: req.user!.role });
const seller = (req: Request): service.Seller => ({ ...actor(req), role: req.user!.role });

/** 201 for a new sale; 200 when the idempotency key matched an earlier one. */
export const create: RequestHandler = async (req, res) => {
  const { sale, replayed } = await service.createSale(req.body as CreateSaleBody, seller(req));
  res.status(replayed ? 200 : 201).json({ sale, replayed });
};

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listSales(req.query as unknown as ListSalesQuery, viewer(req)));
};

export const cashiers: RequestHandler = async (_req, res) => {
  res.json({ cashiers: await service.listSaleCashiers() });
};

export const get: RequestHandler = async (req, res) => {
  res.json({ sale: await service.getSale(params(req).id, viewer(req)) });
};

export const voidSale: RequestHandler = async (req, res) => {
  const sale = await service.voidSale(params(req).id, req.body as VoidSaleBody, actor(req));
  res.json({ sale });
};
