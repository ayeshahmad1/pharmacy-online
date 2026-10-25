import type { CreateSaleBody } from '@pharmacy/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { KEEP_SETTLED_MS } from './sale-queue';
import { REVIEW_CHECK_MS, syncQueue, type SyncApi } from './sync';
import { memoryStore, queued, savedSale } from './test-fixtures';

const NOW = new Date('2026-10-24T07:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

const offline = () => new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
const shortOfStock = () =>
  new ApiError(409, 'INSUFFICIENT_STOCK', 'Not enough stock of Panadol', { items: [] });

/** An API that saves every sale unless told otherwise, numbering receipts in order. */
function fakeApi(overrides: Partial<SyncApi> = {}) {
  let n = 0;
  return {
    createSale: vi.fn<SyncApi['createSale']>(() => {
      n += 1;
      return Promise.resolve({ sale: savedSale(`S-20261024-000${n}`), replayed: false });
    }),
    reportConflict: vi.fn<SyncApi['reportConflict']>((body) =>
      Promise.resolve({ id: `conflict-${body.idempotencyKey}` }),
    ),
    getConflict: vi.fn<SyncApi['getConflict']>().mockResolvedValue({ status: 'OPEN', sale: null }),
    ...overrides,
  };
}

const run = (store: ReturnType<typeof memoryStore>, api: SyncApi, now = NOW, userId = 'u-1') =>
  syncQueue({ store, api, userId, now: () => now });

const keysSent = (api: SyncApi) =>
  vi.mocked(api.createSale).mock.calls.map(([body]: [CreateSaleBody]) => body.idempotencyKey);

describe('syncQueue', () => {
  it('sends pending sales oldest first and records the server’s receipt numbers', async () => {
    const newer = queued({ minutesAgo: 1 });
    const older = queued({ minutesAgo: 5 });
    const store = memoryStore([newer, older]);
    const api = fakeApi();

    const outcome = await run(store, api);

    expect(outcome).toEqual({ synced: 2, flagged: 0, reviewed: 0, stoppedBy: null });
    expect(keysSent(api)).toEqual([older.idempotencyKey, newer.idempotencyKey]);
    expect(store.rows.get(older.idempotencyKey)).toMatchObject({
      status: 'synced',
      attempts: 1,
      sale: { receiptNumber: 'S-20261024-0001' },
      settledAt: NOW.toISOString(),
      lastError: null,
    });
    // Sent exactly as queued: same key, same offline details.
    expect(vi.mocked(api.createSale).mock.calls[0]![0]).toEqual(older.body);
  });

  it('sends each sale once: a second run has nothing to do', async () => {
    const store = memoryStore([queued(), queued()]);
    const api = fakeApi();

    await run(store, api);
    const again = await run(store, api);

    expect(api.createSale).toHaveBeenCalledTimes(2);
    expect(again.synced).toBe(0);
  });

  it('treats a replayed sale (saved by an earlier lost reply) as synced', async () => {
    const sale = queued();
    const store = memoryStore([sale]);
    const api = fakeApi({
      createSale: vi.fn(() =>
        Promise.resolve({ sale: savedSale('S-20261024-0007'), replayed: true }),
      ),
    });

    await run(store, api);
    expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
      status: 'synced',
      sale: { receiptNumber: 'S-20261024-0007' },
    });
  });

  it('only sends the signed-in user’s sales', async () => {
    const mine = queued({ userId: 'u-1' });
    const theirs = queued({ userId: 'u-2' });
    const store = memoryStore([mine, theirs]);
    const api = fakeApi();

    await run(store, api, NOW, 'u-1');

    expect(keysSent(api)).toEqual([mine.idempotencyKey]);
    expect(store.rows.get(theirs.idempotencyKey)!.status).toBe('pending');
  });

  describe('when the server cannot be reached', () => {
    it('stops, keeps the sale pending and schedules a retry with backoff', async () => {
      const first = queued({ minutesAgo: 2 });
      const second = queued({ minutesAgo: 1 });
      const store = memoryStore([first, second]);
      const api = fakeApi({ createSale: vi.fn(() => Promise.reject(offline())) });

      const outcome = await run(store, api);

      expect(outcome.stoppedBy).toBe('offline');
      // Later sales wait their turn rather than overtaking.
      expect(api.createSale).toHaveBeenCalledTimes(1);
      expect(store.rows.get(first.idempotencyKey)).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: { code: 'NETWORK_ERROR' },
        nextAttemptAt: later(5_000).toISOString(),
      });
      expect(store.rows.get(second.idempotencyKey)!.attempts).toBe(0);
    });

    it('waits until the retry time, then backs off further on each failure', async () => {
      const sale = queued();
      const store = memoryStore([sale]);
      const api = fakeApi({ createSale: vi.fn(() => Promise.reject(offline())) });

      await run(store, api);
      const early = await run(store, api, later(1_000));
      expect(early.stoppedBy).toBe('waiting');
      expect(api.createSale).toHaveBeenCalledTimes(1);

      await run(store, api, later(5_000));
      expect(api.createSale).toHaveBeenCalledTimes(2);
      expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
        attempts: 2,
        nextAttemptAt: later(5_000 + 10_000).toISOString(),
      });
    });

    it('sends the sale once the connection is back', async () => {
      const sale = queued();
      const store = memoryStore([sale]);
      const createSale = vi
        .fn<SyncApi['createSale']>()
        .mockRejectedValueOnce(offline())
        .mockResolvedValueOnce({ sale: savedSale('S-20261024-0001'), replayed: false });
      const api = fakeApi({ createSale });

      await run(store, api);
      const outcome = await run(store, api, later(60_000));

      expect(outcome.synced).toBe(1);
      expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
        status: 'synced',
        attempts: 2,
        lastError: null,
        nextAttemptAt: null,
      });
    });

    it('treats a proxy’s 502/503/504 as unreachable and other 5xx as server trouble', async () => {
      const gateway = memoryStore([queued()]);
      await run(
        gateway,
        fakeApi({
          createSale: vi.fn(() =>
            Promise.reject(new ApiError(502, 'INTERNAL_ERROR', 'Bad gateway')),
          ),
        }),
      );
      const crashed = memoryStore([queued()]);
      const outcome = await run(
        crashed,
        fakeApi({
          createSale: vi.fn(() => Promise.reject(new ApiError(500, 'INTERNAL_ERROR', 'Boom'))),
        }),
      );

      expect([...gateway.rows.values()][0]!.lastError!.code).toBe('INTERNAL_ERROR');
      expect(outcome.stoppedBy).toBe('retry');
      expect([...crashed.rows.values()][0]!.status).toBe('pending');
    });
  });

  it('stops without a retry time when the session is gone', async () => {
    const sale = queued();
    const store = memoryStore([sale]);
    const api = fakeApi({
      createSale: vi.fn(() => Promise.reject(new ApiError(401, 'UNAUTHORIZED', 'Log in'))),
    });

    const outcome = await run(store, api);

    expect(outcome.stoppedBy).toBe('auth');
    expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
      status: 'pending',
      nextAttemptAt: null,
    });
    expect(api.reportConflict).not.toHaveBeenCalled();
  });

  describe('when the server refuses a sale', () => {
    it('flags it, reports it for review and carries on with the next one', async () => {
      const refused = queued({ minutesAgo: 2 });
      const next = queued({ minutesAgo: 1 });
      const store = memoryStore([refused, next]);
      const createSale = vi
        .fn<SyncApi['createSale']>()
        .mockRejectedValueOnce(shortOfStock())
        .mockResolvedValueOnce({ sale: savedSale('S-20261024-0001'), replayed: false });
      const api = fakeApi({ createSale });

      const outcome = await run(store, api);

      expect(outcome).toMatchObject({ synced: 1, flagged: 1, stoppedBy: null });
      expect(store.rows.get(refused.idempotencyKey)).toMatchObject({
        status: 'flagged',
        attempts: 1,
        lastError: { code: 'INSUFFICIENT_STOCK', details: { items: [] } },
        conflictId: `conflict-${refused.idempotencyKey}`,
      });
      expect(api.reportConflict).toHaveBeenCalledWith(refused.body, {
        code: 'INSUFFICIENT_STOCK',
        message: 'Not enough stock of Panadol',
        details: { items: [] },
      });
      expect(store.rows.get(next.idempotencyKey)!.status).toBe('synced');
    });

    it.each([
      ['a changed price', new ApiError(409, 'PRICE_CHANGED', 'Prices have changed')],
      ['the cashier cap', new ApiError(403, 'FORBIDDEN', 'At most 10%', { maxDiscount: '5.00' })],
      ['an inactive medicine', new ApiError(400, 'BAD_REQUEST', 'Some items cannot be sold')],
      ['a reused key', new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Different sale')],
    ])('flags %s instead of retrying', async (_label, error) => {
      const sale = queued();
      const store = memoryStore([sale]);
      await run(store, fakeApi({ createSale: vi.fn(() => Promise.reject(error)) }));
      expect(store.rows.get(sale.idempotencyKey)!.status).toBe('flagged');
    });

    it('never sends a flagged sale again', async () => {
      const sale = queued();
      const store = memoryStore([sale]);
      const api = fakeApi({ createSale: vi.fn(() => Promise.reject(shortOfStock())) });

      await run(store, api);
      await run(store, api, later(REVIEW_CHECK_MS + 1));
      expect(api.createSale).toHaveBeenCalledTimes(1);
    });

    it('keeps it flagged and reports it on a later run if reporting fails', async () => {
      const sale = queued();
      const store = memoryStore([sale]);
      const reportConflict = vi
        .fn<SyncApi['reportConflict']>()
        .mockRejectedValueOnce(offline())
        .mockResolvedValueOnce({ id: 'conflict-1' });
      const api = fakeApi({
        createSale: vi.fn(() => Promise.reject(shortOfStock())),
        reportConflict,
      });

      const first = await run(store, api);
      expect(first.stoppedBy).toBe('offline');
      expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
        status: 'flagged',
        conflictId: null,
      });

      await run(store, api, later(1_000));
      expect(store.rows.get(sale.idempotencyKey)!.conflictId).toBe('conflict-1');
    });

    it('marks it synced if the server says it was saved after all', async () => {
      const sale = queued({
        status: 'flagged',
        lastError: { code: 'INSUFFICIENT_STOCK', message: 'Short' },
      });
      const store = memoryStore([sale]);
      const api = fakeApi({
        reportConflict: vi.fn(() =>
          Promise.reject(
            new ApiError(409, 'CONFLICT', 'Already saved', {
              sale: { id: 'sale-9', receiptNumber: 'S-20261024-0009' },
            }),
          ),
        ),
      });

      const outcome = await run(store, api);
      expect(outcome.synced).toBe(1);
      expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
        status: 'synced',
        sale: { id: 'sale-9', receiptNumber: 'S-20261024-0009' },
      });
    });
  });

  describe('reviewed sales', () => {
    const reported = () =>
      queued({
        status: 'flagged',
        conflictId: 'conflict-1',
        checkedAt: NOW.toISOString(),
        lastError: { code: 'INSUFFICIENT_STOCK', message: 'Short' },
      });

    it('asks the server about a reported sale only every few minutes', async () => {
      const store = memoryStore([reported()]);
      const api = fakeApi();

      await run(store, api, later(1_000));
      expect(api.getConflict).not.toHaveBeenCalled();
      await run(store, api, later(REVIEW_CHECK_MS + 1));
      expect(api.getConflict).toHaveBeenCalledWith('conflict-1');
    });

    it('picks up a sale the reviewer saved, with its receipt number', async () => {
      const sale = reported();
      const store = memoryStore([sale]);
      const api = fakeApi({
        getConflict: vi.fn(() =>
          Promise.resolve({
            status: 'RESOLVED' as const,
            sale: { id: 'sale-3', receiptNumber: 'S-20261023-0042' },
          }),
        ),
      });

      const outcome = await run(store, api, later(REVIEW_CHECK_MS + 1));
      expect(outcome.reviewed).toBe(1);
      expect(store.rows.get(sale.idempotencyKey)).toMatchObject({
        status: 'resolved',
        sale: { receiptNumber: 'S-20261023-0042' },
        settledAt: later(REVIEW_CHECK_MS + 1).toISOString(),
      });
    });

    it('picks up a dismissal', async () => {
      const sale = reported();
      const store = memoryStore([sale]);
      const api = fakeApi({
        getConflict: vi.fn(() => Promise.resolve({ status: 'DISMISSED' as const, sale: null })),
      });

      await run(store, api, later(REVIEW_CHECK_MS + 1));
      expect(store.rows.get(sale.idempotencyKey)!.status).toBe('dismissed');
    });
  });

  it('forgets settled sales after a week, but never unsettled ones', async () => {
    const old = queued({ status: 'synced', settledAt: NOW.toISOString(), minutesAgo: 60 });
    const recent = queued({ status: 'synced', settledAt: later(KEEP_SETTLED_MS).toISOString() });
    const stuck = queued({
      status: 'flagged',
      conflictId: 'c',
      checkedAt: later(KEEP_SETTLED_MS).toISOString(),
      minutesAgo: 60 * 24 * 30,
    });
    const store = memoryStore([old, recent, stuck]);

    await run(store, fakeApi(), later(KEEP_SETTLED_MS + 1));

    expect([...store.rows.keys()].sort()).toEqual(
      [recent.idempotencyKey, stuck.idempotencyKey].sort(),
    );
  });
});
