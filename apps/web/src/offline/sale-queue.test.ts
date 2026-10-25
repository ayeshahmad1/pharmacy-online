import { describe, expect, it } from 'vitest';
import { ApiError, isUnreachable } from '@/lib/api';
import {
  classifyFailure,
  offlineRef,
  retryDelayMs,
  stockClaims,
  summarize,
  toSyncError,
} from './sale-queue';
import { queued } from './test-fixtures';

describe('classifyFailure', () => {
  it.each([
    [new ApiError(0, 'NETWORK_ERROR', 'down'), 'offline'],
    [new ApiError(502, 'INTERNAL_ERROR', 'Bad gateway'), 'offline'],
    [new ApiError(504, 'INTERNAL_ERROR', 'Gateway timeout'), 'offline'],
    [new ApiError(500, 'INTERNAL_ERROR', 'Boom'), 'retry'],
    [new ApiError(429, 'BAD_REQUEST', 'Slow down'), 'retry'],
    [new Error('IndexedDB broke'), 'retry'],
    [new ApiError(401, 'UNAUTHORIZED', 'Log in'), 'auth'],
    [new ApiError(403, 'FORBIDDEN', 'Not allowed'), 'auth'],
    [new ApiError(403, 'FORBIDDEN', 'Cap', { maxDiscount: '5.00' }), 'conflict'],
    [new ApiError(409, 'INSUFFICIENT_STOCK', 'Short'), 'conflict'],
    [new ApiError(409, 'PRICE_CHANGED', 'Price'), 'conflict'],
    [new ApiError(400, 'VALIDATION_ERROR', 'Bad'), 'conflict'],
  ] as const)('%s → %s', (err, kind) => {
    expect(classifyFailure(err)).toBe(kind);
  });

  it('knows which failures mean the server was never reached', () => {
    expect(isUnreachable(new ApiError(0, 'NETWORK_ERROR', 'down'))).toBe(true);
    expect(isUnreachable(new ApiError(503, 'INTERNAL_ERROR', 'down'))).toBe(true);
    expect(isUnreachable(new ApiError(500, 'INTERNAL_ERROR', 'Boom'))).toBe(false);
    expect(isUnreachable(new Error('x'))).toBe(false);
  });
});

describe('toSyncError', () => {
  it('keeps the API’s code, message and details', () => {
    expect(toSyncError(new ApiError(409, 'INSUFFICIENT_STOCK', 'Short', { items: [1] }))).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'Short',
      details: { items: [1] },
    });
    expect(toSyncError(new Error('Disk full'))).toEqual({
      code: 'CLIENT_ERROR',
      message: 'Disk full',
    });
  });
});

describe('retryDelayMs', () => {
  it('doubles from 5 seconds up to 5 minutes', () => {
    expect([1, 2, 3, 4, 7, 20].map(retryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 300_000, 300_000,
    ]);
  });
});

describe('offlineRef', () => {
  it('is a short, upper-case reference from the key', () => {
    expect(offlineRef('1a2b3c4d-5e6f-4000-8000-000000000001')).toBe('OFF-1A2B3C4D');
  });
});

describe('stockClaims', () => {
  const snapshotAt = '2026-10-24T06:00:00.000Z';

  it('counts unsettled sales and those settled after the snapshot', () => {
    const pending = queued({ items: [{ medicineId: 'a', quantity: 2 }] });
    const flagged = queued({ status: 'flagged', items: [{ medicineId: 'b', quantity: 1 }] });
    const syncedAfter = queued({
      status: 'synced',
      settledAt: '2026-10-24T06:30:00.000Z',
      items: [{ medicineId: 'c', quantity: 4 }],
    });
    const syncedBefore = queued({
      status: 'synced',
      settledAt: '2026-10-24T05:30:00.000Z',
      items: [{ medicineId: 'd', quantity: 9 }],
    });
    const dismissed = queued({
      status: 'dismissed',
      settledAt: '2026-10-24T06:30:00.000Z',
      items: [{ medicineId: 'e', quantity: 9 }],
    });

    const claims = stockClaims(
      [pending, flagged, syncedAfter, syncedBefore, dismissed],
      snapshotAt,
    );

    expect(claims.map((c) => [c.medicineId, c.quantity])).toEqual([
      ['a', 2],
      ['b', 1],
      ['c', 4],
    ]);
    expect(claims[0]!.soldAt).toBe(pending.body.offline!.soldAt);
  });

  it('counts everything unsettled when there is no snapshot', () => {
    const synced = queued({ status: 'synced', settledAt: snapshotAt });
    expect(stockClaims([queued(), synced], null)).toHaveLength(2);
  });
});

describe('summarize', () => {
  it('counts the user’s pending and flagged sales and others still waiting', () => {
    const failing = queued({
      minutesAgo: 9,
      lastError: { code: 'NETWORK_ERROR', message: 'down' },
    });
    const pending = queued({ minutesAgo: 3 });
    const flagged = queued({ status: 'flagged' });
    const synced = queued({ status: 'synced', settledAt: '2026-10-24T07:00:00.000Z' });
    const someoneElse = queued({ userId: 'u-2' });

    expect(summarize([pending, failing, flagged, synced, someoneElse], 'u-1')).toEqual({
      pending: 2,
      flagged: 1,
      failing: 1,
      othersPending: 1,
      oldestPendingAt: failing.queuedAt,
      lastError: { code: 'NETWORK_ERROR', message: 'down' },
    });
  });
});
