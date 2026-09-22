/**
 * Adversarial HTTP + auth hardening.
 *
 * This file attacks the platform's front door rather than exercising a feature:
 * it proves the auth endpoints are rate limited (F-01), that a spoofed
 * `X-Forwarded-For` cannot buy a fresh rate-limit bucket (F-02), that every
 * response carries the security headers (F-03), and re-proves refresh-token
 * rotation is single-use and that logout revokes (session integrity).
 *
 * The rate-limit budgets are per-IP and per-app-instance; this file builds its
 * own app, so its hammering never leaks into another test's budget. The
 * order-sensitive hammer test runs last so it cannot starve the earlier logins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
const email = `sec-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
const password = 'correct-horse-battery-staple';
const userIds: string[] = [];

async function loginRaw(pw: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers,
    payload: { email, password: pw },
  });
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
});

afterAll(async () => {
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

describe('HTTP + auth hardening', () => {
  it('register succeeds within budget and returns no secret material', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password, displayName: 'Sec Test' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    userIds.push(body.user.id);
    // A response never carries the password hash or the JWT secret.
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('every response carries the security headers (F-03)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['permissions-policy'])).toContain('camera=()');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    // HSTS is production-only; this suite runs outside production.
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('a correct login succeeds and a wrong one is a generic 401 (no oracle)', async () => {
    const good = await loginRaw(password);
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body).accessToken).toBeTruthy();

    const bad = await loginRaw('wrong-password');
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.body).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh rotation is single-use — a replayed refresh token is rejected', async () => {
    const first = JSON.parse((await loginRaw(password)).body);
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const next = JSON.parse(rotated.body);
    expect(next.refreshToken).not.toBe(first.refreshToken);

    // Replaying the now-rotated token must fail: a captured refresh token is
    // useless once it has been exchanged.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error.code).toBe('INVALID_REFRESH');

    // The freshly issued token still works.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: next.refreshToken },
    });
    expect(again.statusCode).toBe(200);
  });

  it('logout revokes the refresh token immediately', async () => {
    const session = JSON.parse((await loginRaw(password)).body);
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: session.refreshToken },
    });
    expect(out.statusCode).toBe(204);
    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  // MUST be last: it deliberately exhausts the per-IP login budget.
  it('login is rate limited, and a spoofed X-Forwarded-For cannot escape it (F-01/F-02)', async () => {
    // Each attempt uses a DIFFERENT forwarded IP. If the header were trusted
    // (trustProxy on), every one would be a fresh bucket and none would trip.
    // With trust off, they all share the real socket IP's bucket, so the limit
    // still trips — proving both that the limit exists and that it cannot be
    // spoofed away.
    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await loginRaw('wrong-password', {
        'x-forwarded-for': `203.0.113.${i % 256}`,
      });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
      // Until the limit trips, a wrong password is a normal 401.
      expect(res.statusCode).toBe(401);
    }
    expect(limited, 'login should become rate limited despite rotating X-Forwarded-For').toBe(true);
  });
});
