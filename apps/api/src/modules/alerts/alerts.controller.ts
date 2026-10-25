import type { AcknowledgeAlertsBody, IdParams, ListAlertsQuery } from '@pharmacy/shared';
import type { Request, RequestHandler } from 'express';
import { actorFrom as actor } from '../../lib/actor';
import * as service from './alerts.service';

// Routes run authenticate (+ requireRole) + validate first.
const params = (req: Request) => req.params as IdParams;

export const list: RequestHandler = async (req, res) => {
  res.json(await service.listAlerts(req.query as unknown as ListAlertsQuery));
};

export const summary: RequestHandler = async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await service.alertSummary());
};

export const acknowledge: RequestHandler = async (req, res) => {
  res.json({ alert: await service.acknowledgeAlert(params(req).id, actor(req)) });
};

export const acknowledgeAll: RequestHandler = async (req, res) => {
  res.json(await service.acknowledgeAlerts(req.body as AcknowledgeAlertsBody, actor(req)));
};

export const refresh: RequestHandler = async (req, res) => {
  res.json(await service.refreshAlertsNow(actor(req)));
};
