import type {
  CreateCategoryBody,
  IdParams,
  ListCategoriesQuery,
  UpdateCategoryBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './categories.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listCategories(req.query as unknown as ListCategoriesQuery));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ category: await service.getCategory(params(req).id) });
};

export const create: RequestHandler = async (req, res) => {
  const category = await service.createCategory(req.body as CreateCategoryBody, actor(req));
  res.status(201).json({ category });
};

export const update: RequestHandler = async (req, res) => {
  const category = await service.updateCategory(
    params(req).id,
    req.body as UpdateCategoryBody,
    actor(req),
  );
  res.json({ category });
};

export const deactivate: RequestHandler = async (req, res) => {
  res.json({ category: await service.deactivateCategory(params(req).id, actor(req)) });
};

export const activate: RequestHandler = async (req, res) => {
  res.json({ category: await service.activateCategory(params(req).id, actor(req)) });
};
