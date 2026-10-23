import type { ApiErrorBody } from '@pharmacy/shared';
import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/** Turns any thrown error into the standard { error: { code, message, details? } } shape. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = toAppError(err);

  if (appError.status >= 500) {
    // req.log (with the request id) is set by pino-http; fall back if it isn't mounted.
    (req.log ?? logger).error({ err }, 'Unhandled error');
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined && { details: appError.details }),
    },
  };
  res.status(appError.status).json(body);
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', z.flattenError(err));
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return new AppError(409, 'CONFLICT', 'A record with this value already exists', {
        fields: err.meta?.target,
      });
    }
    if (err.code === 'P2025') return new AppError(404, 'NOT_FOUND', 'Record not found');
  }

  // Raised by the StockMovement balance trigger (see the stock_movement_guards
  // migration) when a removal slips past the service checks. Prisma reports
  // trigger errors only as text.
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError &&
    err.message.includes('would become negative')
  ) {
    return new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock in the batch');
  }

  // body-parser errors (malformed JSON, body too large) carry a 4xx status
  // and expose: true when the message is safe to show.
  if (isHttpError(err) && err.status < 500) {
    return new AppError(err.status, 'BAD_REQUEST', err.expose ? err.message : 'Bad request');
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
}

function isHttpError(err: unknown): err is { status: number; expose?: boolean; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    err instanceof Error
  );
}
