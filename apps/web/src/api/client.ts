/**
 * REST client.
 *
 * Holds the access token in memory and the refresh token in localStorage, and
 * transparently refreshes once on a 401. It never caches balances or positions:
 * those come from the server on every read, and later over the WebSocket.
 */

const REFRESH_KEY = 'atlas.refreshToken';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setRefreshToken(token: string | null): void {
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

async function parse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function raw(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return fetch(path, { ...init, headers });
}

/**
 * Refresh the access token.
 *
 * Concurrent callers inside this tab share one in-flight attempt, and callers
 * in OTHER TABS are serialised behind a browser-wide lock. Both matter, for
 * the same reason and at different scales.
 *
 * Refresh tokens are single use: the server revokes the presented token in the
 * same statement that accepts it. That is correct - it is how a stolen token
 * gets caught - but it means two simultaneous exchanges of the same token
 * leave one caller holding a revoked one. Tabs share localStorage, so the
 * loser used to call `setRefreshToken(null)` and delete the session the WINNER
 * had just stored. Reloading two tabs at once signed the trader out of both,
 * mid-session, with positions open. See D-013.
 *
 * `navigator.locks` fixes it properly rather than papering over it: the token
 * is read INSIDE the lock, so a tab that waited simply uses whatever the tab
 * ahead of it stored, and the exchanges happen one after another. Nothing
 * about the server's rotation is weakened.
 *
 * Where the Lock API is missing, the fallback is narrower but still correct:
 * a failed exchange only clears the session if storage still holds the token
 * we presented. A different token there means another tab won the race and
 * that token is good - so it is tried, once, instead of signing the trader out.
 */
async function exchange(token: string): Promise<boolean> {
  const response = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  });
  if (!response.ok) return false;
  const data = (await response.json()) as { accessToken: string; refreshToken: string };
  setAccessToken(data.accessToken);
  setRefreshToken(data.refreshToken);
  return true;
}

async function refreshOnce(): Promise<boolean> {
  const token = getRefreshToken();
  if (!token) return false;
  try {
    if (await exchange(token)) return true;
  } catch {
    // A network failure is not a bad token: keep the session and let the
    // caller's request fail on its own terms.
    return false;
  }

  // Another tab may have rotated it between our read and our request.
  const current = getRefreshToken();
  if (current !== null && current !== token) {
    try {
      if (await exchange(current)) return true;
    } catch {
      return false;
    }
  }

  // Only now is the session genuinely gone.
  if (getRefreshToken() === token) {
    setRefreshToken(null);
    setAccessToken(null);
  }
  return false;
}

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  if (!getRefreshToken()) return false;

  refreshInFlight = (async () => {
    try {
      const locks = navigator.locks;
      if (locks) {
        return await locks.request('atlas.auth.refresh', () => refreshOnce());
      }
      return await refreshOnce();
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * The server's own processing time for the last request, in milliseconds.
 *
 * Read from the `x-atlas-ms` header the API sets on every response. It is
 * what separates "Atlas took a while to decide" from "the wire took a while",
 * and the execution instrument reports the two as different numbers rather
 * than as one unhelpful total.
 */
let lastServerMs: number | null = null;

export function serverMsOfLastRequest(): number | null {
  return lastServerMs;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await raw(path, init);

  if (response.status === 401 && (await tryRefresh())) {
    response = await raw(path, init);
  }

  const stamp = Number(response.headers.get('x-atlas-ms'));
  lastServerMs = Number.isFinite(stamp) ? stamp : null;

  const body = await parse(response);
  if (!response.ok) {
    const err = (body as { error?: { code?: string; message?: string; detail?: unknown } })?.error;
    throw new ApiRequestError(
      response.status,
      err?.code ?? 'REQUEST_FAILED',
      err?.message ?? `Request to ${path} failed with ${response.status}.`,
      err?.detail,
    );
  }
  return body as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
};
