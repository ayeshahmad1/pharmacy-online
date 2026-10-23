import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from './error-handler';

function handle(err: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  errorHandler(err, {} as Request, res as unknown as Response, vi.fn());
  return { status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] };
}

describe('errorHandler', () => {
  it('maps the stock balance trigger to 409 INSUFFICIENT_STOCK', () => {
    // What Prisma throws when the StockMovement_non_negative_balance trigger fires.
    const err = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution: ConnectorError(... PostgresError { code: "23514", ' +
        'message: "Stock of batch 0b35de9c would become negative (-1)" ... })',
      { clientVersion: '6.19.3' },
    );
    expect(handle(err)).toEqual({
      status: 409,
      body: { error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock in the batch' } },
    });
  });

  it('does not leak other unknown database errors', () => {
    const err = new Prisma.PrismaClientUnknownRequestError('something else broke', {
      clientVersion: '6.19.3',
    });
    const { status, body } = handle(err);
    expect(status).toBe(500);
    expect(body.error.message).toBe('Something went wrong');
  });
});
