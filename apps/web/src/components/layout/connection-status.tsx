import { CloudIcon, CloudOffIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOffline } from '@/offline/offline-context';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Row({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-right font-medium tabular-nums',
          tone === 'warn' && 'text-amber-700 dark:text-amber-400',
          tone === 'bad' && 'text-red-700 dark:text-red-400',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Online/offline at a glance in the header, with how many sales are waiting
 * to sync and how many were flagged. Opens details and "Sync now".
 */
export function ConnectionStatus() {
  const offline = useOffline();
  const auth = useAuth();
  const { pathname } = useLocation();
  // Open on one page only, so following a link (or any navigation) closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: boolean) => setOpenOn(next ? pathname : null);
  const { online, summary, catalogue } = offline;
  const confirming = online && auth.status === 'authenticated' && !!auth.resumedOffline;

  const label = online ? 'Online' : 'Offline';
  const description = [
    label,
    summary.pending > 0 && plural(summary.pending, 'sale waiting to sync', 'sales waiting to sync'),
    summary.flagged > 0 && plural(summary.flagged, 'sale flagged', 'sales flagged'),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-9 gap-2 px-2.5',
            !online &&
              'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950/60 dark:text-amber-200',
          )}
          aria-label={description}
          title={description}
        >
          {online ? (
            <CloudIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CloudOffIcon className="size-4" />
          )}
          <span className="hidden text-sm font-medium sm:inline">{label}</span>
          {offline.syncing && <RefreshCwIcon className="size-3.5 animate-spin" aria-hidden />}
          {summary.pending > 0 && (
            <Badge variant="warning" className="tabular-nums" aria-hidden>
              {summary.pending} to sync
            </Badge>
          )}
          {summary.flagged > 0 && (
            <Badge variant="danger" className="tabular-nums" aria-hidden>
              {summary.flagged} flagged
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-3 p-4">
        <div>
          <p className="font-semibold">
            {online ? 'Connected to the server' : 'Offline: the server can’t be reached'}
          </p>
          <p className="text-sm text-muted-foreground">
            {confirming
              ? 'Back online. Confirming your session…'
              : online
                ? 'Sales are saved on the server as they are made.'
                : 'You can keep billing. Sales are kept on this device and sync automatically when the connection returns.'}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Row
            label="Waiting to sync"
            value={String(summary.pending)}
            tone={summary.pending > 0 ? 'warn' : undefined}
          />
          <Row
            label="Flagged for review"
            value={String(summary.flagged)}
            tone={summary.flagged > 0 ? 'bad' : undefined}
          />
          {summary.othersPending > 0 && (
            <Row
              label="Other users’ sales"
              value={`${summary.othersPending} waiting for them to log in`}
              tone="warn"
            />
          )}
          {offline.lastSyncAt && (
            <Row label="Last sync" value={formatDateTime(offline.lastSyncAt)} />
          )}
          <Row
            label="Medicine list on this device"
            value={catalogue ? formatDateTime(catalogue.generatedAt) : 'Not saved yet'}
            tone={catalogue ? undefined : 'bad'}
          />
        </div>

        {summary.failing > 0 && summary.lastError && (
          <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
            Last try: {summary.lastError.message}
          </p>
        )}
        {!catalogue && (
          <p className="text-xs text-muted-foreground">
            The medicine list is needed to sell offline. It downloads automatically while online.
          </p>
        )}

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={
              !offline.canSync || offline.syncing || summary.pending + summary.flagged === 0
            }
            onClick={offline.syncNow}
          >
            <RefreshCwIcon className={cn(offline.syncing && 'animate-spin')} />
            Sync now
          </Button>
          <Button variant="outline" className="flex-1" asChild>
            <Link to="/offline-sales">Offline sales</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
