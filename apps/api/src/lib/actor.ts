import type { Request } from 'express';
import { type RequestMeta, requestMeta } from './audit';

/** The signed-in user performing a write, for permission checks and the audit log. */
export type Actor = { id: string; meta: RequestMeta };

/** Only for routes behind `authenticate`, which guarantees req.user. */
export const actorFrom = (req: Request): Actor => ({ id: req.user!.id, meta: requestMeta(req) });
