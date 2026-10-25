// Whether the API can be reached right now. `navigator.onLine` only knows
// about the local network (the counter's Wi-Fi can be up while the internet
// is down), so every API request reports what happened (see api.ts), and
// while offline the server is probed with backoff until it answers.

export type Connectivity = { online: boolean; since: number };

type Listener = () => void;

const PING_URL = '/api/ping';
const PROBE_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 30_000];

let state: Connectivity = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  since: Date.now(),
};
const listeners = new Set<Listener>();
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeRound = 0;

function set(online: boolean) {
  if (online) {
    probeRound = 0;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
  } else {
    scheduleProbe();
  }
  if (state.online === online) return;
  state = { online, since: Date.now() };
  listeners.forEach((l) => l());
}

function scheduleProbe() {
  if (probeTimer || typeof window === 'undefined') return;
  const delay = PROBE_DELAYS_MS[Math.min(probeRound, PROBE_DELAYS_MS.length - 1)]!;
  probeRound += 1;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    void connectivity.probe();
  }, delay);
}

export const connectivity = {
  get: (): Connectivity => state,
  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** An API request got an answer from the server. */
  reachable: () => set(true),
  /** An API request couldn't reach the server. */
  unreachable: () => set(false),
  /** Asks the server whether it is there; any answer from the API itself counts. */
  async probe(): Promise<boolean> {
    try {
      const res = await fetch(PING_URL, { cache: 'no-store', credentials: 'same-origin' });
      // 5xx here comes from the proxy in front of the API, not the API.
      const ok = res.status < 500;
      set(ok);
      return ok;
    } catch {
      set(false);
      return false;
    }
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => set(false));
  window.addEventListener('online', () => void connectivity.probe());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.online) void connectivity.probe();
  });
  if (!state.online) scheduleProbe();
}
