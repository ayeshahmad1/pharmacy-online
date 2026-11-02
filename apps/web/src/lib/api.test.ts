import type { AuthResponse } from '@pharmacy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  isUnreachable,
  login,
  logout,
  onSessionEvent,
  refreshSession,
  setAccessToken,
  type SessionEvent,
} from './api';
import { connectivity } from './connectivity';

const user: AuthResponse['user'] = {
  id: 'u1',
  username: 'cashier1',
  fullName: 'Cashier One',
  email: null,
  role: 'CASHIER',
  status: 'ACTIVE',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const auth = (token: string): AuthResponse => ({ accessToken: token, expiresIn: 900, user });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const unauthorized = () =>
  json(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired access token' } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const fn = vi.fn((input: string, init: RequestInit) => Promise.resolve(handler(input, init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const bearer = (init: RequestInit) => new Headers(init.headers).get('Authorization');

let events: SessionEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  events = [];
  unsubscribe = onSessionEvent((e) => events.push(e));
  setAccessToken(null);
});

afterEach(() => unsubscribe());

describe('api client', () => {
  it('sends the access token as a Bearer header and builds the query string', async () => {
    const fetchMock = mockFetch(() => json(200, { items: [] }));
    setAccessToken('tok-1');

    await api.get('/medicines', { q: 'pana', page: 2, categoryId: undefined, status: '' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/medicines?q=pana&page=2');
    expect(bearer(init)).toBe('Bearer tok-1');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    setAccessToken('expired');
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/auth/refresh') return json(200, auth('fresh'));
      return bearer(init) === 'Bearer fresh' ? json(200, { ok: true }) : unauthorized();
    });

    await expect(api.get('/sales')).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/sales',
      '/api/auth/refresh',
      '/api/sales',
    ]);
    expect(events).toEqual([{ type: 'refreshed', auth: auth('fresh') }]);
  });

  it('shares a single refresh between concurrent requests', async () => {
    setAccessToken('expired');
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/auth/refresh') return json(200, auth('fresh'));
      return bearer(init) === 'Bearer fresh' ? json(200, { url }) : unauthorized();
    });

    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);

    const refreshes = fetchMock.mock.calls.filter(([url]) => url === '/api/auth/refresh');
    expect(refreshes).toHaveLength(1);
  });

  it('ends the session when the refresh is rejected', async () => {
    setAccessToken('expired');
    mockFetch((url) =>
      url === '/api/auth/refresh'
        ? json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Session expired' } })
        : unauthorized(),
    );

    await expect(api.get('/sales')).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(events).toEqual([{ type: 'ended', reason: 'expired' }]);
  });

  it('a failed restore on first load (no token yet) is not reported as an expired session', async () => {
    const fetchMock = mockFetch(() =>
      json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Session expired' } }),
    );

    await expect(refreshSession()).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it('keeps the session when the refresh fails because the network is down', async () => {
    setAccessToken('expired');
    mockFetch((url) => {
      if (url === '/api/auth/refresh') throw new TypeError('Failed to fetch');
      return unauthorized();
    });

    await expect(api.get('/sales')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(events).toEqual([]);
  });

  it('does not try to refresh when there was no token to begin with', async () => {
    const fetchMock = mockFetch(() => unauthorized());

    await expect(api.get('/sales')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns the API error shape into an ApiError', async () => {
    mockFetch(() =>
      json(409, {
        error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock', details: { id: 'm1' } },
      }),
    );

    await expect(api.post('/sales', {})).rejects.toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      message: 'Not enough stock',
      details: { id: 'm1' },
    });
  });

  it('handles non-JSON error pages from the proxy', async () => {
    mockFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));

    await expect(api.get('/sales')).rejects.toMatchObject({
      status: 502,
      code: 'INTERNAL_ERROR',
    });
  });

  it('login stores the token for later requests; logout clears it', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/auth/login') return json(200, auth('tok-login'));
      if (url === '/api/auth/logout') return new Response(null, { status: 204 });
      return json(200, {});
    });

    await login('cashier1', 'secret');
    await api.get('/me');
    expect(bearer(fetchMock.mock.calls[1]![1])).toBe('Bearer tok-login');

    await logout();
    await api.get('/me');
    expect(bearer(fetchMock.mock.calls[3]![1])).toBeNull();
    expect(events).toEqual([{ type: 'ended', reason: 'logout' }]);
  });

  it('downloads files with auth, refreshing once on 401', async () => {
    setAccessToken('tok-old');
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/auth/refresh') return json(200, auth('tok-new'));
      if (bearer(init) !== 'Bearer tok-new') return unauthorized();
      return new Response('a,b', {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="sales-2026.csv"' },
      });
    });

    const { blob, filename } = await api.download('/reports/sales', { format: 'csv' });

    expect(filename).toBe('sales-2026.csv');
    expect(await blob.text()).toBe('a,b');
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/reports/sales?format=csv');
  });

  it('turns a failed download into an ApiError', async () => {
    setAccessToken('tok');
    mockFetch(() => json(403, { error: { code: 'FORBIDDEN', message: 'No' } }));
    await expect(api.download('/reports/sales')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('time limits', () => {
  /** A server that takes the request and never answers, until the request is aborted. */
  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    connectivity.reachable();
  });
  afterEach(() => {
    connectivity.reachable();
    vi.useRealTimers();
  });

  it('gives up on a server that is too slow and treats it as unreachable', async () => {
    mockFetch(hang);
    const request = api.get('/inventory/sellable', { q: 'pana' }, undefined, { timeoutMs: 4000 });
    const settled = request.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(3999);
    expect(connectivity.get().online).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    const err = await settled;
    expect(err).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(isUnreachable(err)).toBe(true);
    expect(connectivity.get().online).toBe(false);
  });

  it("still passes the caller's own cancellation through as an abort", async () => {
    mockFetch(hang);
    const controller = new AbortController();
    const request = api.get('/inventory/sellable', undefined, controller.signal, {
      timeoutMs: 4000,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(connectivity.get().online).toBe(true);
  });

  it('applies to POSTs, and a fast answer is unaffected', async () => {
    mockFetch(hang);
    const slow = api.post('/sales', { items: [] }, { timeoutMs: 12000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(12000);
    expect(isUnreachable(await slow)).toBe(true);

    connectivity.reachable();
    mockFetch(() => json(200, { ok: true }));
    await expect(api.get('/ping', undefined, undefined, { timeoutMs: 10 })).resolves.toEqual({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(connectivity.get().online).toBe(true);
  });

  it('never limits a request that did not ask for it (session refresh included)', async () => {
    mockFetch(hang);
    let done = false;
    void refreshSession()
      .catch(() => undefined)
      .finally(() => (done = true));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(done).toBe(false);
  });
});
