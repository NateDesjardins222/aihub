/**
 * Operational Readiness Phase 1 — the request-correlation + health contract.
 *
 * Proves the operator-facing HTTP behaviours added/hardened in this phase:
 *  - every response carries a safe `x-request-id` for support correlation;
 *  - a client-proposed request id is accepted only if it is a short plain token,
 *    otherwise a fresh server id is issued (no log/audit injection via the id);
 *  - liveness/readiness/version remain secret-free.
 *
 * The security operational SIGNAL (429/403 structured log) is exercised for its
 * OBSERVABLE contract — the codes are unchanged — by the existing auth / authz /
 * rate-limit suites; here we prove the id/correlation surface directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, safeRequestId } from './app.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('safeRequestId — bounded, injection-proof request id', () => {
  it('accepts a short plain token verbatim', () => {
    expect(safeRequestId('abc-123_DEF.4')).toBe('abc-123_DEF.4');
  });
  it('rejects control characters / newlines and generates a uuid instead', () => {
    expect(safeRequestId('bad\ninjected')).toMatch(UUID);
    expect(safeRequestId('has space')).toMatch(UUID);
    expect(safeRequestId('a;b|c')).toMatch(UUID);
  });
  it('rejects an over-long value (> 64 chars) and generates a uuid', () => {
    expect(safeRequestId('x'.repeat(65))).toMatch(UUID);
  });
  it('generates a uuid when no id is supplied or the type is wrong', () => {
    expect(safeRequestId(undefined)).toMatch(UUID);
    expect(safeRequestId(42)).toMatch(UUID);
    expect(safeRequestId({})).toMatch(UUID);
  });
  it('takes the first value when a header arrives as an array', () => {
    expect(safeRequestId(['ok-1', 'ignored'])).toBe('ok-1');
  });
});

describe('request-id correlation on responses', () => {
  it('every response carries an x-request-id header', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes a valid client-supplied x-request-id (cross-hop correlation)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-abc-123' } });
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('does NOT reflect a malformed client id verbatim — it issues a fresh id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'not a valid id!!' } });
    const echoed = res.headers['x-request-id'];
    expect(echoed).not.toBe('not a valid id!!');
    expect(String(echoed)).toMatch(UUID);
  });
});

describe('health surface stays secret-free', () => {
  it('/health, /version, /ready never leak a secret', async () => {
    for (const url of ['/health', '/version', '/ready']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toMatch(/password|secret|jwt|postgres:\/\//i);
    }
  });
});
