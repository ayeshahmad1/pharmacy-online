import type {
  CreateSupplierBody,
  IdParams,
  ListSuppliersQuery,
  UpdateSupplierBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './suppliers.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listSuppliers(req.query as unknown as ListSuppliersQuery));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ supplier: await service.getSupplier(params(req).id) });
};

export const create: RequestHandler = async (req, res) => {
  const supplier = await service.createSupplier(req.body as CreateSupplierBody, actor(req));
  res.status(201).json({ supplier });
};

export const update: RequestHandler = async (req, res) => {
  const supplier = await service.updateSupplier(
    params(req).id,
    req.body as UpdateSupplierBody,
    actor(req),
  );
  res.json({ supplier });
};

export const deactivate: RequestHandler = async (req, res) => {
  res.json({ supplier: await service.deactivateSupplier(params(req).id, actor(req)) });
};

export const activate: RequestHandler = async (req, res) => {
  res.json({ supplier: await service.activateSupplier(params(req).id, actor(req)) });
};
