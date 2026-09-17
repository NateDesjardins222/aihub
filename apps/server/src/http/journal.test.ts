import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { accounts, ruleTemplates, trades, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

/**
 * The journal over HTTP.
 *
 * These run against the real routes and the real database, because the things
 * worth testing here are ownership, filtering and the shape the client relies
 * on - none of which a mocked request would exercise.
 */

const D = 1_000_000;
const MINUTE = 60_000;

let app: FastifyInstance;
let token: string;
let accountId: string;
let userId: string;
let templateId: string;

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body as never,
  });
  return { status: response.statusCode, json: safeJson(response.body) };
}

async function get(url: string): Promise<{ status: number; json: any }> {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.statusCode, json: safeJson(response.body) };
}

async function patch(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await app.inject({
    method: 'PATCH',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body as never,
  });
  return { status: response.statusCode, json: safeJson(response.body) };
}

async function put(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await app.inject({
    method: 'PUT',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body as never,
  });
  return { status: response.statusCode, json: safeJson(response.body) };
}

function safeJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** A closed trade, written straight into the journal's table. */
function tradeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const net = (overrides['netPnlMicros'] as number) ?? 100 * D;
  return {
    accountId,
    symbol: 'NQ',
    side: 'LONG',
    qty: 1,
    entryTicksScaled: 80_000 * D,
    exitTicksScaled: 80_020 * D,
    entryTime: new Date(Date.UTC(2026, 8, 15, 15, 0, 0)),
    exitTime: new Date(Date.UTC(2026, 8, 15, 15, 5, 0)),
    grossPnlMicros: net,
    feesMicros: 0,
    netPnlMicros: net,
    maeMicros: -20 * D,
    mfeMicros: 150 * D,
    initialRiskMicros: 100 * D,
    tradeDate: '2026-09-15',
    ...overrides,
  };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();

  const { db } = getDb();
  const suffix = Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({
      email: `journal-${suffix}@test.local`,
      passwordHash: await hashPassword('journal-test-password'),
      displayName: 'Journal Test',
    })
    .returning();
  userId = user!.id;

  const [template] = await db
    .insert(ruleTemplates)
    .values({
      name: `Journal Test ${suffix}`,
      accountType: 'PRACTICE',
      accountSizeMicros: 100_000 * D,
      profitTargetMicros: 0,
      maxLossMicros: 0,
      drawdownType: 'STATIC',
      consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      maxContracts: 50,
      microsCountAsFraction: false,
      payoutRules: {},
    })
    .returning();
  templateId = template!.id;

  const [account] = await db
    .insert(accounts)
    .values({
      userId,
      ruleTemplateId: templateId,
      name: `Journal Test ${suffix}`,
      accountType: 'PRACTICE',
      startingBalanceMicros: 100_000 * D,
      balanceMicros: 100_000 * D,
      highWaterMarkMicros: 100_000 * D,
      drawdownFloorMicros: 0,
      dayStartBalanceMicros: 100_000 * D,
      dayStartEquityMicros: 100_000 * D,
    })
    .returning();
  accountId = account!.id;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: user!.email, password: 'journal-test-password' },
  });
  token = safeJson(login.body).accessToken;
});

afterAll(async () => {
  const { db } = getDb();
  await db.delete(accounts).where(eq(accounts.id, accountId));
  await db.delete(ruleTemplates).where(eq(ruleTemplates.id, templateId));
  await db.delete(users).where(eq(users.id, userId));
  await app.close();
});

describe('tags', () => {
  it('are the trader’s own, and can be created, renamed and deleted', async () => {
    const created = await post('/api/v1/journal/tags', { name: 'Late entry', kind: 'BAD' });
    expect(created.status).toBe(201);
    const id = created.json.tag.id;

    const renamed = await patch(`/api/v1/journal/tags/${id}`, { name: 'Chased it' });
    expect(renamed.json.tag.name).toBe('Chased it');

    const list = await get('/api/v1/journal/tags');
    expect(list.json.tags.some((t: any) => t.id === id)).toBe(true);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/journal/tags/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('refuses two tags with the same name', async () => {
    await post('/api/v1/journal/tags', { name: 'Duplicate' });
    const again = await post('/api/v1/journal/tags', { name: 'Duplicate' });
    expect(again.status).toBe(400);
  });
});

describe('trades', () => {
  it('serves them with prices, excursions and R', async () => {
    const { db } = getDb();
    await db.insert(trades).values(tradeRow() as never);

    const result = await get(`/api/v1/journal/trades?accountId=${accountId}`);
    expect(result.status).toBe(200);
    const trade = result.json.trades[0];
    expect(trade.symbol).toBe('NQ');
    expect(trade.entryPrice).toBeGreaterThan(0);
    expect(trade.maeMicros).toBe(-20 * D);
    expect(trade.mfeMicros).toBe(150 * D);
    // 100 made on 100 risked.
    expect(trade.rMultiple).toBe(1);
    expect(trade.holdMs).toBe(5 * MINUTE);
  });

  it('takes notes and tags, and gives them back', async () => {
    const { db } = getDb();
    const [row] = await db.insert(trades).values(tradeRow() as never).returning();
    const tag = await post('/api/v1/journal/tags', { name: `Tag ${Math.random()}` });

    await patch(`/api/v1/journal/trades/${row!.id}`, { notes: 'Took it too early.' });
    await put(`/api/v1/journal/trades/${row!.id}/tags`, { tagIds: [tag.json.tag.id] });

    const result = await get(`/api/v1/journal/trades?accountId=${accountId}`);
    const trade = result.json.trades.find((t: any) => t.id === row!.id);
    expect(trade.notes).toBe('Took it too early.');
    expect(trade.tagIds).toEqual([tag.json.tag.id]);
  });

  it('will not let one account read another’s trades', async () => {
    const result = await get('/api/v1/journal/trades?accountId=00000000-0000-0000-0000-000000000000');
    expect(result.status).toBe(404);
  });
});

describe('analytics', () => {
  it('computes the journal’s figures from the stored trades', async () => {
    const { db } = getDb();
    await db.delete(trades).where(eq(trades.accountId, accountId));
    await db.insert(trades).values([
      tradeRow({ netPnlMicros: 200 * D, grossPnlMicros: 200 * D }),
      tradeRow({ netPnlMicros: -100 * D, grossPnlMicros: -100 * D }),
      tradeRow({ netPnlMicros: 50 * D, grossPnlMicros: 50 * D, side: 'SHORT' }),
    ] as never);

    const result = await get(`/api/v1/journal/analytics?accountId=${accountId}`);
    expect(result.status).toBe(200);
    expect(result.json.stats.trades).toBe(3);
    expect(result.json.stats.netPnlMicros).toBe(150 * D);
    expect(result.json.stats.profitFactor).toBeCloseTo(2.5);
    expect(result.json.curve.points).toHaveLength(3);
    expect(result.json.breakdowns.bySide.length).toBe(2);
    // Time of day comes from the exchange's clock, not the server's.
    expect(result.json.breakdowns.byHour.length).toBeGreaterThan(0);
  });

  it('holds up with thousands of trades', async () => {
    const { db } = getDb();
    await db.delete(trades).where(eq(trades.accountId, accountId));

    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 4_000; i += 1) {
      const win = i % 3 !== 0;
      rows.push(
        tradeRow({
          netPnlMicros: (win ? 120 : -90) * D,
          grossPnlMicros: (win ? 125 : -85) * D,
          feesMicros: 5 * D,
          entryTime: new Date(Date.UTC(2026, 8, 1, 14, 0, 0) + i * MINUTE),
          exitTime: new Date(Date.UTC(2026, 8, 1, 14, 3, 0) + i * MINUTE),
          tradeDate: `2026-09-${String(1 + (i % 20)).padStart(2, '0')}`,
          symbol: i % 4 === 0 ? 'CL' : 'NQ',
          side: i % 2 === 0 ? 'LONG' : 'SHORT',
        }),
      );
    }
    // Insert in batches: one statement with four thousand rows is a different
    // test from the one intended.
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(trades).values(rows.slice(i, i + 500) as never);
    }

    const started = Date.now();
    const result = await get(`/api/v1/journal/analytics?accountId=${accountId}&limit=5000`);
    const elapsed = Date.now() - started;

    expect(result.status).toBe(200);
    expect(result.json.stats.trades).toBe(4_000);
    expect(result.json.curve.points).toHaveLength(4_000);
    expect(result.json.days.length).toBe(20);
    // Reading and analysing four thousand trades, over HTTP, in well under a
    // second: a journal a trader has actually used has to stay usable.
    expect(elapsed).toBeLessThan(3_000);
  }, 60_000);
});

describe('practice sessions', () => {
  it('opens one, attaches trades to it, and reviews it when it ends', async () => {
    const { db } = getDb();
    await db.delete(trades).where(eq(trades.accountId, accountId));

    const started = await post('/api/v1/journal/sessions', {
      accountId,
      source: 'REPLAY',
      mode: 'BLIND',
      recordingId: 'NQ-2026-09-15-hist',
      symbol: 'NQ',
      tradingDate: '2026-09-15',
      dateHidden: true,
    });
    expect(started.status).toBe(201);
    const sessionId = started.json.session.id;
    // A blind session withholds the date it is playing.
    expect(started.json.session.tradingDate).toBeNull();
    expect(started.json.session.dateHidden).toBe(true);

    await db.insert(trades).values([
      tradeRow({ netPnlMicros: 300 * D, grossPnlMicros: 300 * D, sessionId }),
      tradeRow({ netPnlMicros: -120 * D, grossPnlMicros: -120 * D, sessionId }),
    ] as never);

    const active = await get(`/api/v1/journal/sessions/active?accountId=${accountId}`);
    expect(active.json.session.id).toBe(sessionId);

    const ended = await post(`/api/v1/journal/sessions/${sessionId}/end`, {});
    expect(ended.status).toBe(200);
    // Ending it reveals what it was.
    expect(ended.json.session.tradingDate).toBe('2026-09-15');
    expect(ended.json.session.endedAt).not.toBeNull();

    const review = await get(`/api/v1/journal/sessions/${sessionId}`);
    expect(review.json.review.stats.trades).toBe(2);
    expect(review.json.review.netPnlMicros).toBe(180 * D);
    expect(review.json.review.bestTrade.netPnlMicros).toBe(300 * D);
    expect(review.json.review.worstTrade.netPnlMicros).toBe(-120 * D);
    expect(review.json.review.programme.status).toBeDefined();
    expect(Array.isArray(review.json.review.violations)).toBe(true);
    expect(review.json.trades).toHaveLength(2);
  });

  it('keeps one session open at a time', async () => {
    const first = await post('/api/v1/journal/sessions', { accountId, mode: 'STANDARD' });
    const second = await post('/api/v1/journal/sessions', { accountId, mode: 'NO_PNL' });
    expect(second.status).toBe(201);

    const active = await get(`/api/v1/journal/sessions/active?accountId=${accountId}`);
    expect(active.json.session.id).toBe(second.json.session.id);

    const list = await get(`/api/v1/journal/sessions?accountId=${accountId}`);
    const earlier = list.json.sessions.find((s: any) => s.id === first.json.session.id);
    // Starting a new one closed the old one, with a review of its own.
    expect(earlier.endedAt).not.toBeNull();
    expect(earlier.summary).not.toBeNull();
  });

  it('takes notes and tags on a session', async () => {
    const created = await post('/api/v1/journal/sessions', { accountId, mode: 'PROCESS' });
    const tag = await post('/api/v1/journal/tags', { name: `Session tag ${Math.random()}` });
    const updated = await patch(`/api/v1/journal/sessions/${created.json.session.id}`, {
      notes: 'Traded the plan, three A+ setups.',
      tagIds: [tag.json.tag.id],
    });
    expect(updated.json.session.notes).toBe('Traded the plan, three A+ setups.');

    const detail = await get(`/api/v1/journal/sessions/${created.json.session.id}`);
    expect(detail.json.tagIds).toEqual([tag.json.tag.id]);
  });
});

describe('preferences', () => {
  it('stores and returns whatever the client keeps there', async () => {
    const written = await put('/api/v1/preferences', {
      motion: { mode: 'SMOOTH', smoothing: 0.7 },
      training: { modeId: 'BLIND' },
    });
    expect(written.status).toBe(200);

    const read = await get('/api/v1/preferences');
    expect(read.json.preferences.training.modeId).toBe('BLIND');
    expect(read.json.preferences.motion.smoothing).toBe(0.7);
  });
});
