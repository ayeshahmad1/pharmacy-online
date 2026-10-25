import { createContext, useContext } from 'react';
import type { CatalogueMeta } from './catalogue';
import type { QueueSummary } from './sale-queue';
import type { SyncOutcome } from './sync';

export type OfflineContextValue = {
  /** The API answered the last time it was asked. */
  online: boolean;
  /** Signed in with a session the server has confirmed, so sales can be sent. */
  canSync: boolean;
  summary: QueueSummary;
  syncing: boolean;
  lastSyncAt: string | null;
  lastOutcome: SyncOutcome | null;
  /** The medicine list saved on this device, if any. */
  catalogue: CatalogueMeta | null;
  catalogueError: string | null;
  /** Sends queued sales now (no-op while it can't). */
  syncNow: () => void;
  /** Downloads the medicine list again. */
  refreshCatalogue: () => Promise<void>;
};

export const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOffline(): OfflineContextValue {
  const context = useContext(OfflineContext);
  if (!context) throw new Error('useOffline must be used inside <OfflineProvider>');
  return context;
}
