import type {
  AdjustStockBody,
  ExpiredStockQuery,
  ExpiringStockQuery,
  IdParams,
  ListMovementsQuery,
  ListStockQuery,
  LowStockQuery,
  MedicineStockQuery,
  ReceiveStockBody,
  SellableSearchQuery,
  WriteOffExpiredBody,
} from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './inventory.service';

// Routes run authenticate + validate first, so req.user is set and
// body/query/params are already parsed by their Zod schemas.
const params = (req: Request) => req.params as IdParams;
const query = <T>(req: Request) => req.query as unknown as T;
const viewer = (req: Request): service.Viewer => ({ role: req.user!.role });

export const receive: RequestHandler = async (req, res) => {
  const batches = await service.receiveStock(req.body as ReceiveStockBody, actor(req));
  res.status(201).json({ batches });
};

export const adjust: RequestHandler = async (req, res) => {
  const adjustment = await service.adjustStock(req.body as AdjustStockBody, actor(req));
  res.status(201).json({ adjustment });
};

export const writeOffExpired: RequestHandler = async (req, res) => {
  const writeOff = await service.writeOffExpired(req.body as WriteOffExpiredBody, actor(req));
  res.status(201).json({ writeOff });
};

export const listStock: RequestHandler = async (req, res) => {
  res.json(await service.listStock(query<ListStockQuery>(req)));
};

export const medicineStock: RequestHandler = async (req, res) => {
  const stock = await service.getMedicineStock(
    params(req).id,
    query<MedicineStockQuery>(req),
    viewer(req),
  );
  res.json({ stock });
};

export const searchSellable: RequestHandler = async (req, res) => {
  res.json({ items: await service.searchSellable(query<SellableSearchQuery>(req)) });
};

export const offlineCatalogue: RequestHandler = async (_req, res) => {
  // Always the live numbers: never let a proxy or the browser serve an old copy.
  res.set('Cache-Control', 'no-store');
  res.json(await service.getOfflineCatalogue());
};

export const getSellable: RequestHandler = async (req, res) => {
  res.json({ medicine: await service.getSellable(params(req).id) });
};

export const substitutes: RequestHandler = async (req, res) => {
  res.json(await service.listSubstitutes(params(req).id));
};

export const getBatch: RequestHandler = async (req, res) => {
  res.json({ batch: await service.getBatch(params(req).id, viewer(req)) });
};

export const lowStock: RequestHandler = async (req, res) => {
  res.json(await service.listLowStock(query<LowStockQuery>(req)));
};

export const expiring: RequestHandler = async (req, res) => {
  res.json(await service.listExpiring(query<ExpiringStockQuery>(req), viewer(req)));
};

export const expired: RequestHandler = async (req, res) => {
  res.json(await service.listExpired(query<ExpiredStockQuery>(req), viewer(req)));
};

export const movements: RequestHandler = async (req, res) => {
  res.json(await service.listMovements(query<ListMovementsQuery>(req)));
};
