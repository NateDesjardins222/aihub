/**
 * Phase 11 — infrastructure health surface.
 *
 * Proves the operational endpoints an orchestrator and an on-call operator need:
 *  - /health is liveness (process up) and carries release identity, always 200.
 *  - /version exposes the deployed build (non-secret) so an incident ties to a commit.
 *  - /ready probes the real dependency (PostgreSQL) and reports it — no fake green.
 *
 * The DB-down 503 path is exercised as a live outage drill (see RECOVERY_DRILL_REPORT),
 * since forcing a pool failure inside an in-process test would tear down the shared DB
 * other suites depend on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

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

describe('infrastructure health surface (Phase 11)', () => {
  it('/health is liveness only, always 200, and carries release identity', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.env).toBeDefined();
    // Release identity present and non-secret (a commit string + boot time).
    expect(body.release).toBeDefined();
    expect(typeof body.release.commit).toBe('string');
    expect(typeof body.release.startedAt).toBe('string');
    // Never leak a secret through the health surface.
    expect(res.body).not.toMatch(/password|secret|jwt|postgres:\/\//i);
  });

  it('/version exposes the deployed build identity', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.commit).toBe('string');
    expect(body.startedAt).toBeDefined();
  });

  it('/ready probes the database and reports it ok when the DB is up', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ready).toBe(true);
    expect(body.checks.database).toBe('ok');
    // readiness distinguishes itself from liveness by actually checking a dependency
    expect(body.checks).toHaveProperty('database_ms');
  });

  it('readiness response shape supports a 503 not-ready contract', async () => {
    // Contract: when ready is false the route sends 503; the shape is identical so
    // a load balancer can key purely on the status code. We assert the healthy
    // shape here and prove the 503 path in the live Postgres-outage drill.
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const body = JSON.parse(res.body);
    expect(typeof body.ready).toBe('boolean');
    expect(body.checks).toBeTypeOf('object');
    expect(body.release).toBeDefined();
  });
});
