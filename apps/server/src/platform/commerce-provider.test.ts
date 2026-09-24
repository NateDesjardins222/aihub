/**
 * The commerce provider abstraction and the commerce_events dedup ledger.
 *
 * The security-critical guarantees: an event is only accepted when its signature
 * verifies; a replayed event id is deduped (even under concurrency); a stale
 * timestamp is rejected; a bad signature is RECORDED as REJECTED (not dropped)
 * and cannot poison a real event's dedup slot; and the Whop provider reports
 * itself unconfigured without a secret.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { commerceEvents } from '../db/schema.js';
import { defaultOrganizationId } from './provisioning.js';
import {
  MockCommerceProvider,
  WhopCommerceProvider,
  signMockCommerceEvent,
  type RawCommerceEvent,
} from './commerce-provider.js';
import { recordCommerceEvent } from './commerce-events.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const eventIds: string[] = [];
const provider = new MockCommerceProvider();

/** A signed mock event: JSON body + Standard Webhooks headers with the mock secret. */
function signedEvent(
  body: Record<string, unknown>,
  opts: { id?: string; timestampMs?: number } = {},
): RawCommerceEvent {
  const rawBody = JSON.stringify(body);
  const headers = signMockCommerceEvent(rawBody, opts);
  return { rawBody, headers };
}

async function record(raw: RawCommerceEvent) {
  const outcome = await recordCommerceEvent(db, { organizationId, provider, raw });
  if ('row' in outcome && outcome.row) eventIds.push(outcome.row.id);
  return outcome;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
});

afterAll(async () => {
  if (eventIds.length > 0) {
    await db.delete(commerceEvents).where(inArray(commerceEvents.id, eventIds));
  }
  await app.close();
});

describe('MockCommerceProvider verification + normalisation', () => {
  it('verifies a correctly signed event and rejects a tampered body', () => {
    const raw = signedEvent({ id: 'e1', type: 'payment.succeeded', atlasOrderId: 'o1' });
    expect(provider.verifyEvent(raw).ok).toBe(true);
    const tampered: RawCommerceEvent = { rawBody: raw.rawBody + ' ', headers: raw.headers };
    expect(provider.verifyEvent(tampered).ok).toBe(false);
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const raw = signedEvent(
      { id: 'e-stale', type: 'payment.succeeded' },
      { timestampMs: Date.now() - 60 * 60 * 1000 },
    );
    const v = provider.verifyEvent(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/timestamp/i);
  });

  it('normalises kind, order id, amount and currency', () => {
    const raw = signedEvent({
      id: 'e2',
      type: 'payment.succeeded',
      atlasOrderId: 'order-123',
      amountMicros: 95_000_000,
      currency: 'USD',
    });
    const n = provider.normalizeEvent(raw);
    expect(n.kind).toBe('PAYMENT_SUCCEEDED');
    expect(n.atlasOrderId).toBe('order-123');
    expect(n.amountMicros).toBe(95_000_000);
    expect(n.currency).toBe('USD');
  });
});

describe('recordCommerceEvent dedup ledger', () => {
  it('accepts a valid event and dedups an exact replay', async () => {
    const raw = signedEvent({ id: `pay-${crypto.randomUUID()}`, type: 'payment.succeeded', atlasOrderId: 'o' });
    const first = await record(raw);
    expect(first.kind).toBe('ACCEPTED');
    const replay = await record(raw);
    expect(replay.kind).toBe('DUPLICATE');
  });

  it('records a bad signature as REJECTED (not dropped)', async () => {
    const raw = signedEvent({ id: `bad-${crypto.randomUUID()}`, type: 'payment.succeeded' });
    const tampered: RawCommerceEvent = { rawBody: raw.rawBody + 'x', headers: raw.headers };
    const outcome = await record(tampered);
    expect(outcome.kind).toBe('REJECTED');
    if (outcome.kind === 'REJECTED') expect(outcome.row.status).toBe('REJECTED');
  });

  it('is exactly-once under 10 concurrent identical deliveries', async () => {
    const raw = signedEvent({ id: `race-${crypto.randomUUID()}`, type: 'payment.succeeded', atlasOrderId: 'o' });
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => record(raw)));
    const accepted = outcomes.filter((o) => o.kind === 'ACCEPTED');
    const duplicates = outcomes.filter((o) => o.kind === 'DUPLICATE');
    expect(accepted.length).toBe(1);
    expect(duplicates.length).toBe(9);
  });

  it('normalises an unknown event type to UNKNOWN and still records it', async () => {
    const raw = signedEvent({ id: `unk-${crypto.randomUUID()}`, type: 'account.something_else' });
    const outcome = await record(raw);
    expect(outcome.kind).toBe('ACCEPTED');
    if (outcome.kind === 'ACCEPTED') expect(outcome.normalized.kind).toBe('UNKNOWN');
  });
});

describe('WhopCommerceProvider seam', () => {
  it('reports itself unconfigured without a webhook secret', () => {
    expect(new WhopCommerceProvider().isConfigured()).toBe(false);
  });

  it('returns a not-configured checkout config without a sandbox client', async () => {
    const config = await new WhopCommerceProvider().createCheckout({ orderId: 'o', planId: 'plan_x' });
    expect(config.configured).toBe(false);
    expect(config.provider).toBe('WHOP');
  });
});
