import type {
  CreateMedicineBody,
  IdParams,
  ListMedicinesQuery,
  UpdateMedicineBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './medicines.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listMedicines(req.query as unknown as ListMedicinesQuery));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ medicine: await service.getMedicine(params(req).id) });
};

export const create: RequestHandler = async (req, res) => {
  const medicine = await service.createMedicine(req.body as CreateMedicineBody, actor(req));
  res.status(201).json({ medicine });
};

export const update: RequestHandler = async (req, res) => {
  const medicine = await service.updateMedicine(
    params(req).id,
    req.body as UpdateMedicineBody,
    actor(req),
  );
  res.json({ medicine });
};

export const deactivate: RequestHandler = async (req, res) => {
  res.json({ medicine: await service.deactivateMedicine(params(req).id, actor(req)) });
};

export const activate: RequestHandler = async (req, res) => {
  res.json({ medicine: await service.activateMedicine(params(req).id, actor(req)) });
};
