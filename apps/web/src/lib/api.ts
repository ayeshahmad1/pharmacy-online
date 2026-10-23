import type { ApiErrorBody, AuthResponse, ErrorCode } from '@pharmacy/shared';

/**
 * API client. The access token lives only in memory (never localStorage); the
 * refresh token is an httpOnly cookie the browser sends to /api/auth itself.
 * A 401 triggers one refresh (shared by every request that hit it) and a
 * single retry. If the refresh is rejected the session is over and listeners
 * are told, so the app can return to the login page.
 */

const API_BASE = '/api';
const REFRESH_LOCK = 'pharmacy-auth-refresh';
const AUTH_CHANNEL = 'pharmacy-auth';

export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type SessionEvent =
  { type: 'refreshed'; auth: AuthResponse } | { type: 'ended'; reason: 'expired' | 'logout' };

type SessionListener = (event: SessionEvent) => void;

let accessToken: string | null = null;
let refreshInFlight: Promise<AuthResponse> | null = null;
const listeners = new Set<SessionListener>();

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);
// A logout in another tab revoked the shared refresh cookie; end this tab's session too.
channel?.addEventListener('message', (event: MessageEvent) => {
  if (event.data === 'logout') endSession('logout');
});

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function onSessionEvent(listener: SessionListener) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(event: SessionEvent) {
  for (const listener of listeners) listener(event);
}

function endSession(reason: 'expired' | 'logout') {
  // No token means no session to end, e.g. the restore attempt on first load.
  if (accessToken === null) return;
  accessToken = null;
  emit({ type: 'ended', reason });
}

type Query = Record<string, string | number | boolean | null | undefined>;

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
};

function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  try {
    return await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (err) {
    // Let cancellations (e.g. TanStack Query unmounts) propagate unchanged.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check the connection.');
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) return body as T;

  const error = (body as Partial<ApiErrorBody> | undefined)?.error;
  if (error?.code && error.message) {
    throw new ApiError(res.status, error.code, error.message, error.details);
  }
  // Not our error shape, e.g. an HTML 502 page from the reverse proxy.
  throw new ApiError(res.status, 'INTERNAL_ERROR', `Server error (${res.status})`);
}

async function doRefresh(): Promise<AuthResponse> {
  try {
    const auth = await parse<AuthResponse>(await send('/auth/refresh', { method: 'POST' }));
    accessToken = auth.accessToken;
    emit({ type: 'refreshed', auth });
    return auth;
  } catch (err) {
    // Only a rejected refresh ends the session. A network failure does not:
    // the counter must not be logged out because the internet dropped.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      endSession('expired');
    }
    throw err;
  }
}

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers in
 * this tab share one request, and a Web Lock serialises refreshes across tabs:
 * the server rotates the token on every refresh and treats a reused one as
 * theft, so two tabs refreshing with the same cookie would log everyone out.
 */
export function refreshSession(): Promise<AuthResponse> {
  if (!refreshInFlight) {
    const run = async (): Promise<AuthResponse> =>
      typeof navigator !== 'undefined' && 'locks' in navigator
        ? await navigator.locks.request(REFRESH_LOCK, doRefresh)
        : doRefresh();
    refreshInFlight = run().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const tokenUsed = accessToken;
  const res = await send(path, options);

  if (res.status === 401 && tokenUsed) {
    // Another request may already have refreshed while this one was in flight.
    if (accessToken === tokenUsed) await refreshSession();
    return parse<T>(await send(path, options));
  }
  return parse<T>(res);
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

export async function login(username: string, password: string): Promise<AuthResponse> {
  const auth = await parse<AuthResponse>(
    await send('/auth/login', { method: 'POST', body: { username, password } }),
  );
  accessToken = auth.accessToken;
  return auth;
}

export async function logout(): Promise<void> {
  try {
    await send('/auth/logout', { method: 'POST' });
  } catch {
    // Offline: the server could not revoke the refresh token, but this tab's
    // session still ends locally.
  } finally {
    channel?.postMessage('logout');
    endSession('logout');
  }
}

/** A message fit for a toast or inline error. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
