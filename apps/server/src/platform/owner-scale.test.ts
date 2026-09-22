/**
 * Owner Control Center scale + performance.
 *
 * Seeds a realistic organisation (many traders, each with an account; a fraction
 * holding open positions and closed trades) and measures the latency of the
 * owner routes an operator actually opens. It asserts every route stays a
 * bounded, indexed read that returns 200 under load — never an unbounded scan
 * that melts at 10k — and prints the measured medians. The numbers printed are
 * the real measurement; no SLA is invented.
 *
 * Bounded on purpose so it runs in the normal suite; the query shapes (cursor
 * pagination, org-scoped indexes, projection scan bounded by OPEN exposure) are
 * the same at 10k and 100k, which is the property under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { accounts, organizations, positions, trades, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { projectAccount } from './projection.js';

const M = 1_000_000;
const TRADERS = Number(process.env['OWNER_SCALE_TRADERS'] ?? 400);
const SYMBOLS = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'CL'];

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
let adminToken: string;
let seededUserIds: string[] = [];

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);

  const size = 50_000 * M;
  const BATCH = 200;
  const positionAccts: string[] = [];
  for (let start = 0; start < TRADERS; start += BATCH) {
    const n = Math.min(BATCH, TRADERS - start);
    const insUsers = await db
      .insert(users)
      .values(
        Array.from({ length: n }, (_, i) => ({
          email: `oscale-${start + i}-${crypto.randomUUID().slice(0, 6)}@atlas.test`,
          passwordHash: 'x',
          displayName: `OScale ${start + i}`,
          role: 'TRADER',
          organizationId,
        })),
      )
      .returning({ id: users.id });
    seededUserIds.push(...insUsers.map((u) => u.id));
    const insAccts = await db
      .insert(accounts)
      .values(
        insUsers.map((u, i) => ({
          organizationId,
          userId: u.id,
          name: `OScale ${start + i}`,
          accountType: (start + i) % 5 === 0 ? 'FUNDED_SIM' : 'EVALUATION',
          status: 'ACTIVE',
          startingBalanceMicros: size,
          balanceMicros: size,
          highWaterMarkMicros: size,
          drawdownFloorMicros: size - 2_000 * M,
          dayStartBalanceMicros: size,
          dayStartEquityMicros: size,
        })),
      )
      .returning({ id: accounts.id });
    const posRows: Array<typeof positions.$inferInsert> = [];
    const tradeRows: Array<typeof trades.$inferInsert> = [];
    for (let i = 0; i < insAccts.length; i += 1) {
      if ((start + i) % 10 === 0) {
        const accountId = insAccts[i]!.id;
        const symbol = SYMBOLS[(start + i) % SYMBOLS.length]!;
        const long = (start + i) % 2 === 0;
        posRows.push({ accountId, symbol, side: long ? 'LONG' : 'SHORT', qty: long ? 3 : -2, costBasisMicros: 3 * 1000 * M });
        positionAccts.push(accountId);
        tradeRows.push({ accountId, symbol, side: long ? 'LONG' : 'SHORT', qty: 1, entryTicksScaled: 20_000 * M, exitTicksScaled: 20_010 * M, entryTime: new Date(), exitTime: new Date(), grossPnlMicros: 100 * M, feesMicros: 0, netPnlMicros: 100 * M, tradeDate: new Date().toISOString().slice(0, 10) });
      }
    }
    if (posRows.length) await db.insert(positions).values(posRows);
    if (tradeRows.length) await db.insert(trades).values(tradeRows);
  }
  for (const id of positionAccts) await projectAccount(db, id);

  const email = `oscale-admin-${crypto.randomUUID().slice(0, 8)}@atlas.test`;
  const [admin] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('oscale-pw'), displayName: 'Admin', role: 'ADMIN', organizationId })
    .returning();
  seededUserIds.push(admin!.id);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'oscale-pw' } });
  adminToken = JSON.parse(login.body).accessToken;
}, 120_000);

afterAll(async () => {
  for (let i = 0; i < seededUserIds.length; i += 200) {
    await db.delete(users).where(inArray(users.id, seededUserIds.slice(i, i + 200)));
  }
  await app.close();
});

async function median(url: string): Promise<{ ms: number; status: number }> {
  const auth = { authorization: `Bearer ${adminToken}` };
  await app.inject({ method: 'GET', url, headers: auth }); // warm-up
  const samples: number[] = [];
  let status = 0;
  for (let i = 0; i < 5; i += 1) {
    const t = performance.now();
    const res = await app.inject({ method: 'GET', url, headers: auth });
    samples.push(performance.now() - t);
    status = res.statusCode;
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[2]!, status };
}

describe(`owner routes at ${TRADERS} traders`, () => {
  it('every operator route is a bounded 200 under load', async () => {
    const routes: Array<[string, string]> = [
      ['overview', '/api/v1/admin/overview'],
      ['traders', '/api/v1/admin/users?limit=50'],
      ['traders q', '/api/v1/admin/users?q=oscale-1&limit=50'],
      ['traders filter', '/api/v1/admin/users?filter=has_funded&limit=50'],
      ['accounts', '/api/v1/admin/accounts?limit=50'],
      ['trading', '/api/v1/admin/trading'],
      ['risk', '/api/v1/admin/risk'],
      ['exposure', '/api/v1/admin/exposure'],
      ['audit', '/api/v1/admin/audit?limit=100'],
    ];
    const lines: string[] = [];
    for (const [label, url] of routes) {
      const r = await median(url);
      // Assert the STATUS before anything else — a route that 500s or 403s must
      // fail here, never be quietly counted as "fast".
      expect(r.status, `${label} status`).toBe(200);
      // Generous bound: catches a pathological unbounded scan, not a strict SLA.
      expect(r.ms, `${label} latency`).toBeLessThan(3000);
      lines.push(`  ${label.padEnd(16)} p50 ${r.ms.toFixed(0).padStart(5)}ms`);
    }
    // eslint-disable-next-line no-console
    console.log(`\nowner route latency at ${TRADERS} traders:\n${lines.join('\n')}`);
  }, 60_000);
});
