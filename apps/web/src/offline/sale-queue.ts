// Sales completed at the counter that the server hasn't confirmed yet: made
// while offline, or tried online and the reply never came. Each keeps its
// request exactly as first built, idempotency key included, so sending it
// again can never save it twice. Kept in IndexedDB until synced; a sale the
// server refuses is flagged for review, never dropped.

import type { CreateSaleBody, SaleDto } from '@pharmacy/shared';
import { ApiError, isUnreachable } from '@/lib/api';
import type { StockClaim } from './catalogue';
import { localDb, STORES } from './db';

export type QueuedSaleStatus =
  /** Waiting to reach the server. */
  | 'pending'
  /** The server refused it and a person has to decide. Reported once `conflictId` is set. */
  | 'flagged'
  /** Saved on the server. */
  | 'synced'
  /** Flagged, then saved by a reviewer. */
  | 'resolved'
  /** Flagged, then dismissed by a reviewer. */
  | 'dismissed';

export type SyncError = { code: string; message: string; details?: unknown };

export type QueuedSale = {
  idempotencyKey: string;
  /** Who made it. Only their session syncs it: the API ties a sale to the signed-in user. */
  userId: string;
  cashierName: string;
  /** The request, `offline` included. Never changed once queued, so every try replays it. */
  body: CreateSaleBody;
  /** The provisional receipt printed at the counter. */
  receipt: SaleDto;
  status: QueuedSaleStatus;
  queuedAt: string;
  attempts: number;
  /** Earliest time to try again after a failure; null means now. */
  nextAttemptAt: string | null;
  lastError: SyncError | null;
  /** The server's sale once saved (synced or resolved). */
  sale: { id: string; receiptNumber: string } | null;
  /** The server's record of a flagged sale, once reported. */
  conflictId: string | null;
  /** When the flagged sale's review status was last checked. */
  checkedAt: string | null;
  /** When this device learnt it was saved, resolved or dismissed. */
  settledAt: string | null;
};

export const isSettled = (s: QueuedSale) =>
  s.status === 'synced' || s.status === 'resolved' || s.status === 'dismissed';

/** Short reference printed on the provisional receipt until the server numbers the sale. */
export const offlineRef = (idempotencyKey: string) =>
  `OFF-${idempotencyKey.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

export function newQueuedSale(opts: {
  body: CreateSaleBody;
  receipt: SaleDto;
  user: { id: string; fullName: string };
  now?: Date;
}): QueuedSale {
  return {
    idempotencyKey: opts.body.idempotencyKey,
    userId: opts.user.id,
    cashierName: opts.user.fullName,
    body: opts.body,
    receipt: opts.receipt,
    status: 'pending',
    queuedAt: (opts.now ?? new Date()).toISOString(),
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    sale: null,
    conflictId: null,
    checkedAt: null,
    settledAt: null,
  };
}

// ─── Failures ───────────────────────────────────────────────────────────────

/**
 * What a failed request means for the queue:
 * - `offline`: the server can't be reached. Stop and try again later.
 * - `retry`: the server is struggling (5xx, rate limit). Stop, back off.
 * - `auth`: no usable session. Stop until the user signs in again.
 * - `conflict`: the server read the sale and refused it (stock, price,
 *   discount cap, inactive medicine...). Trying again won't help: flag it.
 */
export type FailureKind = 'offline' | 'retry' | 'auth' | 'conflict';

export function classifyFailure(err: unknown): FailureKind {
  if (!(err instanceof ApiError)) return 'retry';
  if (isUnreachable(err)) return 'offline';
  if (err.status >= 500 || err.status === 408 || err.status === 429) return 'retry';
  if (err.status === 401) return 'auth';
  // The cashier discount cap is a 403 about the sale; any other 403 is about the user.
  const details = typeof err.details === 'object' && err.details ? err.details : {};
  if (err.status === 403 && !('maxDiscount' in details)) return 'auth';
  return 'conflict';
}

export function toSyncError(err: unknown): SyncError {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined && { details: err.details }),
    };
  }
  return { code: 'CLIENT_ERROR', message: err instanceof Error ? err.message : String(err) };
}

const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

/** Wait before try `attempts + 1`: 5 s, doubling, at most 5 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

// ─── Derived views ──────────────────────────────────────────────────────────

/**
 * Units this device's sales took that a catalogue snapshot taken at
 * `generatedAt` doesn't reflect: everything not yet settled, plus what
 * settled after the snapshot was taken. A dismissed sale stops counting once
 * settled: its stock was put right by hand on review.
 */
export function stockClaims(sales: QueuedSale[], generatedAt: string | null): StockClaim[] {
  return sales
    .filter((s) => !s.settledAt || !generatedAt || s.settledAt > generatedAt)
    .filter((s) => s.status !== 'dismissed')
    .flatMap((s) =>
      s.body.items.map((item) => ({
        medicineId: item.medicineId,
        quantity: item.quantity,
        soldAt: s.body.offline?.soldAt ?? s.queuedAt,
      })),
    );
}

export type QueueSummary = {
  /** The user's sales still to send. */
  pending: number;
  /** The user's sales the server refused that are still waiting for review. */
  flagged: number;
  /** Pending sales that failed at least once. */
  failing: number;
  /** Sales by other users on this device, waiting for them to sign in. */
  othersPending: number;
  oldestPendingAt: string | null;
  lastError: SyncError | null;
};

export function summarize(sales: QueuedSale[], userId: string): QueueSummary {
  const mine = sales.filter((s) => s.userId === userId);
  const pending = mine
    .filter((s) => s.status === 'pending')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  return {
    pending: pending.length,
    flagged: mine.filter((s) => s.status === 'flagged').length,
    failing: pending.filter((s) => s.lastError).length,
    othersPending: sales.filter((s) => s.userId !== userId && !isSettled(s)).length,
    oldestPendingAt: pending[0]?.queuedAt ?? null,
    lastError: pending.find((s) => s.lastError)?.lastError ?? null,
  };
}

/** Settled sales stay listed this long, so the counter can look up their receipt numbers. */
export const KEEP_SETTLED_MS = 7 * 24 * 60 * 60 * 1000;

export const isExpiredRecord = (s: QueuedSale, now: Date) =>
  !!s.settledAt && now.getTime() - new Date(s.settledAt).getTime() > KEEP_SETTLED_MS;

// ─── Storage ────────────────────────────────────────────────────────────────

export type QueueStore = {
  list(): Promise<QueuedSale[]>;
  put(sale: QueuedSale): Promise<void>;
  remove(idempotencyKey: string): Promise<void>;
};

type Listener = () => void;
const listeners = new Set<Listener>();
const CHANNEL = 'pharmacy-sale-queue';
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
// Another tab changed the queue: refresh counts here too.
channel?.addEventListener('message', () => listeners.forEach((l) => l()));

function changed() {
  listeners.forEach((l) => l());
  channel?.postMessage('changed');
}

/** The queue in this device's IndexedDB. Every change is announced to all tabs. */
export const saleQueue: QueueStore & { subscribe(listener: Listener): () => void } = {
  /** Oldest first: the order they must reach the server in. */
  async list() {
    const sales = await localDb.getAll<QueuedSale>(STORES.saleQueue);
    return sales.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  },
  async put(sale) {
    await localDb.put(STORES.saleQueue, sale);
    changed();
  },
  async remove(idempotencyKey) {
    await localDb.delete(STORES.saleQueue, idempotencyKey);
    changed();
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};
