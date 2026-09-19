/**
 * What happens when two tabs refresh at the same moment.
 *
 * Refresh tokens are single use, and tabs share localStorage. The loser of a
 * benign race used to delete the session the winner had just stored, which
 * signed the trader out of every tab at once. These tests pin the recovery
 * rather than the lock: `navigator.locks` is absent under Node, so what runs
 * here is exactly the fallback a browser without the Lock API would take.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'atlas.refreshToken';

function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

describe('the REST client under refresh-token rotation', () => {
  beforeEach(() => {
    installStorage();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adopts the token another tab stored instead of signing the trader out', async () => {
    const client = await import('./client');
    localStorage.setItem(KEY, 'first');
    client.setAccessToken('stale');

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push(path);
        if (path === '/api/v1/auth/refresh') {
          const presented = JSON.parse(String(init?.body)).refreshToken as string;
          if (presented === 'first') {
            // The other tab got there first and has already stored its own.
            localStorage.setItem(KEY, 'second');
            return new Response('{}', { status: 401 });
          }
          return new Response(
            JSON.stringify({ accessToken: 'fresh', refreshToken: 'third' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const authorized = new Headers(init?.headers).get('authorization');
        return authorized === 'Bearer fresh'
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response('{}', { status: 401 });
      }),
    );

    await expect(client.request('/api/v1/accounts')).resolves.toEqual({ ok: true });
    expect(localStorage.getItem(KEY)).toBe('third');
    expect(calls.filter((c) => c === '/api/v1/auth/refresh')).toHaveLength(2);
  });

  it('signs the trader out only when the stored token is the one that failed', async () => {
    const client = await import('./client');
    localStorage.setItem(KEY, 'expired');
    client.setAccessToken('stale');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );

    await expect(client.request('/api/v1/accounts')).rejects.toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(client.getAccessToken()).toBeNull();
  });

  it('keeps the session when the refresh cannot be sent at all', async () => {
    const client = await import('./client');
    localStorage.setItem(KEY, 'good');
    client.setAccessToken('stale');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/v1/auth/refresh') throw new TypeError('network down');
        return new Response('{}', { status: 401 });
      }),
    );

    await expect(client.request('/api/v1/accounts')).rejects.toThrow();
    // A dropped connection is not a revoked token. Signing out here would log
    // a trader out of an open position because their wifi blinked.
    expect(localStorage.getItem(KEY)).toBe('good');
  });
});
