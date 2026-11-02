import type { ListLegacyPurchasesQuery, ListLegacyReturnsQuery } from '@pharmacy/shared';
import type { RequestHandler } from 'express';
import * as service from './legacy.service';

// Routes run authenticate + requireRole + validate first.

export const listPurchases: RequestHandler = async (req, res) => {
  res.json(await service.listPurchases(req.query as unknown as ListLegacyPurchasesQuery));
};

export const listReturns: RequestHandler = async (req, res) => {
  res.json(await service.listReturns(req.query as unknown as ListLegacyReturnsQuery));
};
