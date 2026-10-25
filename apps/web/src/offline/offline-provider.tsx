import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useAuth, useCurrentUser } from '@/features/auth/auth-context';
import { invalidateStock } from '@/features/inventory/inventory-api';
import { errorMessage } from '@/lib/api';
import { connectivity } from '@/lib/connectivity';
import { catalogueStore, refreshCatalogue } from './catalogue-store';
import { syncApi, offlineKeys } from './offline-api';
import { OfflineContext, type OfflineContextValue } from './offline-context';
import { saleQueue, summarize, type QueueSummary } from './sale-queue';
import { syncQueue, type SyncOutcome } from './sync';

/** While sales are waiting, try this often (each sale's own backoff still applies). */
const SYNC_INTERVAL_MS = 15_000;
/** Keep the saved medicine list at most this old while online. */
const CATALOGUE_MAX_AGE_MS = 5 * 60_000;
const SYNC_LOCK = 'pharmacy-sale-sync';

const emptySummary: QueueSummary = {
  pending: 0,
  flagged: 0,
  failing: 0,
  othersPending: 0,
  oldestPendingAt: null,
  lastError: null,
};

/**
 * Only one sync at a time across every tab of this browser: the queue is
 * shared, and two tabs sending the same sale would race (safely, thanks to
 * idempotency keys, but pointlessly). A tab that finds the lock taken skips.
 */
async function withSyncLock<T>(run: () => Promise<T>): Promise<T | null> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return run();
  return navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, (lock) => (lock ? run() : null));
}

/**
 * Keeps offline billing running for the signed-in user: the medicine list on
 * this device fresh while online, and queued sales sent whenever the server
 * can be reached (on reconnect, after each new sale, and on a timer while any
 * wait). Mounted once inside the signed-in layout.
 */
export function OfflineProvider({ children }: { children: ReactNode }) {
  const user = useCurrentUser();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(connectivity.subscribe, () => connectivity.get().online);
  const catalogue = useSyncExternalStore(catalogueStore.subscribe, catalogueStore.meta);
  const canSync = online && auth.status === 'authenticated' && !auth.resumedOffline;

  const [summary, setSummary] = useState<QueueSummary>(emptySummary);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const running = useRef(false);
  const canSyncRef = useRef(canSync);
  useEffect(() => {
    canSyncRef.current = canSync;
  }, [canSync]);

  // Counts for the header, kept current as the queue changes (in any tab).
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      saleQueue
        .list()
        .then((sales) => !cancelled && setSummary(summarize(sales, user.id)))
        .catch(() => undefined);
    void load();
    const unsubscribe = saleQueue.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user.id]);

  useEffect(() => {
    // Read what's saved, so offline lookups and the status are ready.
    catalogueStore.load().catch(() => undefined);
  }, []);

  const updateCatalogue = useCallback(async () => {
    try {
      await refreshCatalogue();
      setCatalogueError(null);
    } catch (err) {
      setCatalogueError(errorMessage(err));
    }
  }, []);

  const syncNow = useCallback(() => {
    if (!canSyncRef.current || running.current) return;
    running.current = true;
    setSyncing(true);
    void withSyncLock(() => syncQueue({ store: saleQueue, api: syncApi, userId: user.id }))
      .then((outcome) => {
        if (!outcome) return;
        setLastOutcome(outcome);
        setLastSyncAt(new Date().toISOString());
        const saved = outcome.synced;
        if (saved > 0) {
          toast.success(
            saved === 1 ? 'An offline sale was synced' : `${saved} offline sales synced`,
          );
        }
        if (outcome.flagged > 0) {
          toast.warning(
            outcome.flagged === 1
              ? 'An offline sale could not be saved and was flagged for review'
              : `${outcome.flagged} offline sales could not be saved and were flagged for review`,
            { duration: 10_000 },
          );
        }
        if (outcome.synced > 0 || outcome.flagged > 0 || outcome.reviewed > 0) {
          // Stock moved on the server: refresh lookups, stock screens, the list here.
          void queryClient.invalidateQueries({ queryKey: ['billing'] });
          void queryClient.invalidateQueries({ queryKey: offlineKeys.all });
          void invalidateStock(queryClient);
          void updateCatalogue();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        running.current = false;
        setSyncing(false);
      });
  }, [user.id, queryClient, updateCatalogue]);

  // Sync as soon as it's possible: sign-in, a confirmed session, reconnection.
  useEffect(() => {
    if (canSync) syncNow();
  }, [canSync, syncNow]);

  // Keep trying while anything is outstanding.
  const outstanding = summary.pending + summary.flagged > 0;
  useEffect(() => {
    if (!canSync || !outstanding) return;
    const timer = setInterval(syncNow, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [canSync, outstanding, syncNow]);

  // The medicine list: fetched when missing or old, then every few minutes.
  useEffect(() => {
    if (!canSync) return;
    const age = catalogue ? Date.now() - new Date(catalogue.generatedAt).getTime() : Infinity;
    const timer = setTimeout(() => void updateCatalogue(), Math.max(0, CATALOGUE_MAX_AGE_MS - age));
    return () => clearTimeout(timer);
  }, [canSync, catalogue, updateCatalogue]);

  const value = useMemo<OfflineContextValue>(
    () => ({
      online,
      canSync,
      summary,
      syncing,
      lastSyncAt,
      lastOutcome,
      catalogue,
      catalogueError,
      syncNow,
      refreshCatalogue: updateCatalogue,
    }),
    [
      online,
      canSync,
      summary,
      syncing,
      lastSyncAt,
      lastOutcome,
      catalogue,
      catalogueError,
      syncNow,
      updateCatalogue,
    ],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}
