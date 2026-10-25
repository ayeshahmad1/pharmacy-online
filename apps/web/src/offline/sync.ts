// Sends this device's queued sales to the server, oldest first, and keeps
// each record's status in step with what the server said. Pure apart from the
// store and API passed in, so every path is unit-tested (sync.test.ts).
//
// Rules:
// - One user's sales only: the API records the signed-in user as the cashier.
// - Strictly in order. If a sale can't be sent now (offline, server trouble,
//   no session), the run stops rather than letting later sales take stock an
//   earlier one needs.
// - A sale the server refuses is flagged and reported for review; the run
//   moves on to the next one. Nothing is ever dropped.
// - Every request is safe to repeat: sales by idempotency key, reports by the
//   same key on the server.

import type { CreateSaleBody, OfflineConflictStatus, SaleDto } from '@pharmacy/shared';
import { ApiError } from '@/lib/api';
import {
  classifyFailure,
  isExpiredRecord,
  retryDelayMs,
  toSyncError,
  type FailureKind,
  type QueueStore,
  type QueuedSale,
  type SyncError,
} from './sale-queue';

export type SyncApi = {
  createSale: (body: CreateSaleBody) => Promise<{ sale: SaleDto; replayed: boolean }>;
  reportConflict: (body: CreateSaleBody, error: SyncError) => Promise<{ id: string }>;
  getConflict: (id: string) => Promise<{
    status: OfflineConflictStatus;
    sale: { id: string; receiptNumber: string } | null;
  }>;
};

export type SyncOutcome = {
  synced: number;
  flagged: number;
  /** Flagged sales a reviewer has since saved or dismissed. */
  reviewed: number;
  /** Why the run stopped early, if it did. `waiting`: the next sale's retry time hasn't come. */
  stoppedBy: FailureKind | 'waiting' | null;
};

/** How often to ask the server whether a flagged sale has been reviewed. */
export const REVIEW_CHECK_MS = 2 * 60_000;

export async function syncQueue(opts: {
  store: QueueStore;
  api: SyncApi;
  userId: string;
  now?: () => Date;
}): Promise<SyncOutcome> {
  const { store, api, userId } = opts;
  const now = opts.now ?? (() => new Date());
  const outcome: SyncOutcome = { synced: 0, flagged: 0, reviewed: 0, stoppedBy: null };

  const all = await store.list();
  const mine = all
    .filter((s) => s.userId === userId)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

  // 1. Pending sales, in order.
  for (const sale of mine.filter((s) => s.status === 'pending')) {
    if (sale.nextAttemptAt && new Date(sale.nextAttemptAt) > now()) {
      outcome.stoppedBy = 'waiting';
      break;
    }
    const attempts = sale.attempts + 1;
    try {
      const { sale: saved } = await api.createSale(sale.body);
      await store.put({
        ...sale,
        status: 'synced',
        attempts,
        nextAttemptAt: null,
        lastError: null,
        sale: { id: saved.id, receiptNumber: saved.receiptNumber },
        settledAt: now().toISOString(),
      });
      outcome.synced += 1;
    } catch (err) {
      const kind = classifyFailure(err);
      if (kind === 'conflict') {
        await store.put({
          ...sale,
          status: 'flagged',
          attempts,
          nextAttemptAt: null,
          lastError: toSyncError(err),
        });
        outcome.flagged += 1;
        continue;
      }
      await store.put({
        ...sale,
        attempts,
        lastError: toSyncError(err),
        // Without a session nothing will work until the user signs in again.
        nextAttemptAt:
          kind === 'auth' ? null : new Date(now().getTime() + retryDelayMs(attempts)).toISOString(),
      });
      outcome.stoppedBy = kind;
      break;
    }
  }
  if (outcome.stoppedBy && outcome.stoppedBy !== 'waiting') return outcome;

  // 2. Report flagged sales the server has no record of yet, and 3. ask about
  // reported ones now and then. Re-read: step 1 may have flagged some.
  const flagged = (await store.list()).filter((s) => s.userId === userId && s.status === 'flagged');
  for (const sale of flagged) {
    const stop = sale.conflictId
      ? await checkReview(sale, store, api, now, outcome)
      : await report(sale, store, api, now, outcome);
    if (stop) {
      outcome.stoppedBy = stop;
      break;
    }
  }

  await purge(all, store, now());
  return outcome;
}

/** Hands a flagged sale to the server's review list. Returns why to stop, if it must. */
async function report(
  sale: QueuedSale,
  store: QueueStore,
  api: SyncApi,
  now: () => Date,
  outcome: SyncOutcome,
): Promise<FailureKind | null> {
  try {
    const { id } = await api.reportConflict(sale.body, sale.lastError ?? unknownError);
    await store.put({ ...sale, conflictId: id, checkedAt: now().toISOString() });
    return null;
  } catch (err) {
    const savedAs = alreadySaved(err);
    if (savedAs) {
      // The sale exists after all: an earlier try got through.
      await store.put({
        ...sale,
        status: 'synced',
        sale: savedAs,
        lastError: null,
        settledAt: now().toISOString(),
      });
      outcome.synced += 1;
      return null;
    }
    const kind = classifyFailure(err);
    // Refused outright (it shouldn't be): keep it flagged here and try again next run.
    return kind === 'conflict' ? null : kind;
  }
}

/** Picks up a reviewer's decision on a reported sale. */
async function checkReview(
  sale: QueuedSale,
  store: QueueStore,
  api: SyncApi,
  now: () => Date,
  outcome: SyncOutcome,
): Promise<FailureKind | null> {
  if (sale.checkedAt && now().getTime() - new Date(sale.checkedAt).getTime() < REVIEW_CHECK_MS) {
    return null;
  }
  try {
    const review = await api.getConflict(sale.conflictId!);
    const checkedAt = now().toISOString();
    if (review.status === 'OPEN') {
      await store.put({ ...sale, checkedAt });
      return null;
    }
    await store.put({
      ...sale,
      status: review.status === 'RESOLVED' ? 'resolved' : 'dismissed',
      sale: review.sale,
      checkedAt,
      settledAt: checkedAt,
    });
    outcome.reviewed += 1;
    return null;
  } catch (err) {
    const kind = classifyFailure(err);
    return kind === 'conflict' ? null : kind;
  }
}

const unknownError: SyncError = { code: 'UNKNOWN', message: 'The server refused this sale' };

/** The sale the server says this key was already saved as (409 CONFLICT from a report). */
function alreadySaved(err: unknown): { id: string; receiptNumber: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'CONFLICT') return null;
  const sale = (err.details as { sale?: { id?: unknown; receiptNumber?: unknown } } | undefined)
    ?.sale;
  return typeof sale?.id === 'string' && typeof sale.receiptNumber === 'string'
    ? { id: sale.id, receiptNumber: sale.receiptNumber }
    : null;
}

/** Forgets settled sales once they are old enough not to be looked up any more. */
async function purge(sales: QueuedSale[], store: QueueStore, now: Date) {
  for (const sale of sales) {
    if (isExpiredRecord(sale, now)) await store.remove(sale.idempotencyKey);
  }
}
