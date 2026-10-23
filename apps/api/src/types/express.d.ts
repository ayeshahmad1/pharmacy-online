import type { RoleCode } from '@pharmacy/shared';

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware. */
      user?: { id: string; username: string; role: RoleCode };
    }
  }
}

export {};
