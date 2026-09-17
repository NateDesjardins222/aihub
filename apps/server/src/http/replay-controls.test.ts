import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { getDb } from '../db/client.js';
import { accounts, ruleTemplates, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

/**
 * The replay controls over HTTP.
 *
 * A practice session is only worth anything if the transport is trustworthy:
 * stepping moves exactly one event, a jump lands where it says, skipping is
 * refused while there is something to skip past, and a blind session gives away
 * nothing about which day it is.
 */

const D = 1_000_000;

let app: FastifyInstance;
let token: string;
let accountId: string;
let userId: string;
let templateId: string;

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as never }),
  });
  let json: any = response.body;
  try {
    json = JSON.parse(response.body);
  } catch {
    /* keep the raw body */
  }
  return { status: response.statusCode, json };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  // The recordings the development environment captured live here.
  process.env['REPLAY_DIR'] = new URL('../../data/recordings', import.meta.url).pathname;

  app = (await buildApp()).app;
  await app.ready();

  const { db } = getDb();
  const suffix = Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({
      email: `replay-${suffix}@test.local`,
      passwordHash: await hashPassword('replay-test-password'),
      displayName: 'Replay Test',
    })
    .returning();
  userId = user!.id;

  const [template] = await db
    .insert(ruleTemplates)
    .values({
      name: `Replay Test ${suffix}`,
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
      name: `Replay Test ${suffix}`,
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
    payload: { email: user!.email, password: 'replay-test-password' },
  });
  token = JSON.parse(login.body).accessToken;
});

afterAll(async () => {
  const { db } = getDb();
  await call('POST', '/api/v1/marketdata/replay/pause');
  await db.delete(accounts).where(eq(accounts.id, accountId));
  await db.delete(ruleTemplates).where(eq(ruleTemplates.id, templateId));
  await db.delete(users).where(eq(users.id, userId));
  await app.close();
});

async function loadFirstRecording(): Promise<string> {
  const list = await call('GET', '/api/v1/marketdata/recordings');
  const recording = list.json.recordings[0];
  expect(recording, 'the development recordings must be present').toBeDefined();
  await call('POST', '/api/v1/marketdata/replay/load', { recordingId: recording.id });
  return recording.id;
}

describe('the transport', () => {
  it('steps exactly one event at a time', async () => {
    await loadFirstRecording();
    const before = await call('GET', '/api/v1/marketdata/replay');
    const stepped = await call('POST', '/api/v1/marketdata/replay/step', { count: 1 });
    expect(stepped.json.cursor).toBe(before.json.cursor + 1);
    expect(stepped.json.playing).toBe(false);

    const many = await call('POST', '/api/v1/marketdata/replay/step', { count: 25 });
    expect(many.json.cursor).toBe(stepped.json.cursor + 25);
  });

  it('restarts from the beginning', async () => {
    await loadFirstRecording();
    await call('POST', '/api/v1/marketdata/replay/step', { count: 40 });
    const restarted = await call('POST', '/api/v1/marketdata/replay/restart');
    expect(restarted.json.cursor).toBeLessThanOrEqual(1);
    expect(restarted.json.playing).toBe(true);
    await call('POST', '/api/v1/marketdata/replay/pause');
  });

  it('accepts every offered speed, including half and a hundred', async () => {
    await loadFirstRecording();
    for (const speed of [0.5, 1, 2, 5, 10, 25, 50, 100]) {
      const result = await call('POST', '/api/v1/marketdata/replay/speed', { speed });
      expect(result.status).toBe(200);
      expect(result.json.speed).toBe(speed);
    }
    const refused = await call('POST', '/api/v1/marketdata/replay/speed', { speed: 3 });
    expect(refused.status).toBe(400);
  });

  it('jumps to a session anchor and lands on it', async () => {
    await loadFirstRecording();
    const anchors = await call('GET', '/api/v1/marketdata/replay/anchors');
    expect(anchors.json.anchors.length).toBeGreaterThan(0);

    const target = anchors.json.anchors[Math.floor(anchors.json.anchors.length / 2)];
    const jumped = await call('POST', '/api/v1/marketdata/replay/seek-time', { ts: target.at });
    expect(jumped.status).toBe(200);
    // The clock is at or just past the anchor: events land on their own
    // timestamps, so the first one at or after it is where the replay stops.
    expect(jumped.json.clock).toBeGreaterThanOrEqual(target.at - 60_000);
    expect(jumped.json.cursor).toBeGreaterThan(0);
  });

  it('replays forwards rather than skipping, so the clock never goes backwards silently', async () => {
    await loadFirstRecording();
    const anchors = await call('GET', '/api/v1/marketdata/replay/anchors');
    const late = anchors.json.anchors[anchors.json.anchors.length - 1];
    const early = anchors.json.anchors[0];

    const forward = await call('POST', '/api/v1/marketdata/replay/seek-time', { ts: late.at });
    const back = await call('POST', '/api/v1/marketdata/replay/seek-time', { ts: early.at });
    expect(back.json.cursor).toBeLessThan(forward.json.cursor);
    expect(back.json.clock).toBeLessThanOrEqual(forward.json.clock);
  });
});

describe('skipping forward', () => {
  it('is allowed while the account is flat', async () => {
    await loadFirstRecording();
    await call('POST', '/api/v1/marketdata/replay/step', { count: 5 });
    const before = await call('GET', '/api/v1/marketdata/replay');
    const skipped = await call('POST', '/api/v1/marketdata/replay/skip', {
      accountId,
      minutes: 30,
    });
    expect(skipped.status).toBe(200);
    expect(skipped.json.cursor).toBeGreaterThan(before.json.cursor);
  });

  it('is refused while an order is working', async () => {
    await loadFirstRecording();
    await call('POST', '/api/v1/marketdata/replay/step', { count: 5 });
    await call('POST', '/api/v1/marketdata/provider', { provider: 'replay' });
    await call('POST', '/api/v1/marketdata/replay/step', { count: 5 });

    const state = await call('GET', '/api/v1/marketdata/replay');
    const symbol = state.json.symbol ?? 'NQ';
    const quote = await call('GET', `/api/v1/marketdata/quote?symbol=${symbol}`);
    const last = quote.json.quote?.last;
    expect(last, 'the replay must be publishing a price').toBeTruthy();

    const order = await call('POST', '/api/v1/orders', {
      accountId,
      clientOrderId: crypto.randomUUID(),
      symbol,
      side: 'BUY',
      qty: 1,
      type: 'LIMIT',
      limitPrice: Math.round((last - 200) * 4) / 4,
      tif: 'DAY',
    });
    expect(order.status).toBe(201);

    const refused = await call('POST', '/api/v1/marketdata/replay/skip', { accountId, minutes: 10 });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('NOT_FLAT');

    await call('POST', '/api/v1/orders/cancel-all', { accountId });
    const allowed = await call('POST', '/api/v1/marketdata/replay/skip', { accountId, minutes: 10 });
    expect(allowed.status).toBe(200);

    await call('POST', '/api/v1/marketdata/provider', { provider: 'live' });
  }, 60_000);
});

describe('a blind session', () => {
  it('gives away neither its recording, its date nor its clock', async () => {
    const random = await call('POST', '/api/v1/marketdata/replay/random', { blind: true });
    expect(random.status).toBe(200);
    expect(random.json.blind).toBe(true);
    expect(random.json.recordingId).toBeNull();
    expect(random.json.clock).toBeNull();
    expect(random.json.header).toBeNull();
    // What it CAN say is how far in it is, which identifies nothing.
    expect(random.json.elapsedMs).not.toBeUndefined();

    const state = await call('GET', '/api/v1/marketdata/replay');
    expect(state.json.recordingId).toBeNull();
    expect(state.json.startTs).toBeNull();

    // And its anchors are offered as offsets rather than timestamps, so a
    // trader can still jump to the New York open without learning the date.
    const anchors = await call('GET', '/api/v1/marketdata/replay/anchors');
    for (const anchor of anchors.json.anchors) {
      expect(anchor.at).toBeNull();
      expect(typeof anchor.offsetMs).toBe('number');
    }
  });

  it('is an ordinary session once loaded by hand', async () => {
    const id = await loadFirstRecording();
    const state = await call('GET', '/api/v1/marketdata/replay');
    expect(state.json.blind).toBe(false);
    expect(state.json.recordingId).toBe(id);
    expect(state.json.header).not.toBeNull();
  });
});

describe('the session catalogue', () => {
  it('lists what is captured and what could be', async () => {
    const result = await call('GET', '/api/v1/marketdata/sessions?symbol=NQ&days=8');
    expect(result.status).toBe(200);
    expect(result.json.recordings.every((r: any) => r.symbol === 'NQ')).toBe(true);
    expect(result.json.dates).toHaveLength(8);
    // Weekends have no session to capture, so they are not offered.
    expect(result.json.dates.every((d: any) => d.weekday <= 5)).toBe(true);
    expect(result.json.historyNote).toMatch(/seven days/i);
  });
});
