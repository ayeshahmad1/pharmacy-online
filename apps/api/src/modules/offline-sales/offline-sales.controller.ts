import type {
  DismissOfflineConflictBody,
  IdParams,
  ListOfflineConflictsQuery,
  ReportOfflineConflictBody,
  RetryOfflineConflictBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import type { Seller } from '../sales/sales.service';
import * as service from './offline-sales.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;
const viewer = (req: Request): service.Viewer => ({ id: req.user!.id, role: req.user!.role });
const reviewer = (req: Request): Seller => ({ ...actor(req), role: req.user!.role });

/** 201 for a new report; 200 when this sale had already been reported. */
export const report: RequestHandler = async (req, res) => {
  const result = await service.reportConflict(req.body as ReportOfflineConflictBody, actor(req));
  res.status(result.created ? 201 : 200).json({ conflict: result.conflict });
};

export const list: RequestHandler = async (req, res) => {
  const query = req.query as unknown as ListOfflineConflictsQuery;
  res.json(await service.listConflicts(query, viewer(req)));
};

export const get: RequestHandler = async (req, res) => {
  res.json({ conflict: await service.getConflict(params(req).id, viewer(req)) });
};

export const retry: RequestHandler = async (req, res) => {
  const body = req.body as RetryOfflineConflictBody;
  res.json({ conflict: await service.retryConflict(params(req).id, body, reviewer(req)) });
};

export const dismiss: RequestHandler = async (req, res) => {
  const body = req.body as DismissOfflineConflictBody;
  res.json({ conflict: await service.dismissConflict(params(req).id, body, actor(req)) });
};
