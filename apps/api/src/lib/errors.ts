import type { ErrorCode } from '@pharmacy/shared';

/** An expected error that maps directly to an API error response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

/** An idempotency key was sent again with a different request, or by another user. */
export const idempotencyKeyReused = (message: string) =>
  new AppError(409, 'IDEMPOTENCY_KEY_REUSED', message);

/** A stock-removing change asks for more than the batch has on hand (rule 3). */
export const insufficientStock = (message: string, details?: unknown) =>
  new AppError(409, 'INSUFFICIENT_STOCK', message, details);
