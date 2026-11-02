import type {
  DeliveryBody,
  IdParams,
  ListDeliveriesQuery,
  RejectDeliveryBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './deliveries.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;
const viewer = (req: Request): service.Viewer => ({ id: req.user!.id, role: req.user!.role });
const staff = (req: Request): service.Staff => ({ ...actor(req), role: req.user!.role });

/** 201 whether the delivery went into stock at once or is waiting for approval; see `status`. */
export const create: RequestHandler = async (req, res) => {
  const delivery = await service.createDelivery(req.body as DeliveryBody, staff(req));
  res.status(201).json({ delivery });
};

export const update: RequestHandler = async (req, res) => {
  const delivery = await service.updateDelivery(
    params(req).id,
    req.body as DeliveryBody,
    staff(req),
  );
  res.json({ delivery });
};

export const approve: RequestHandler = async (req, res) => {
  res.json({ delivery: await service.approveDelivery(params(req).id, actor(req)) });
};

export const reject: RequestHandler = async (req, res) => {
  const delivery = await service.rejectDelivery(
    params(req).id,
    req.body as RejectDeliveryBody,
    actor(req),
  );
  res.json({ delivery });
};

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listDeliveries(req.query as unknown as ListDeliveriesQuery, viewer(req)));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ delivery: await service.getDelivery(params(req).id, viewer(req)) });
};
