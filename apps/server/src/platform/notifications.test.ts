/**
 * Customer notifications — idempotency, delivery, suppression, and the async
 * event consumer, against the real database.
 *
 * The guarantees: a retried event never sends the same notification twice
 * (unique dedupe key); the mock provider records a SENT row; an unconfigured
 * real provider SUPPRESSES rather than faking delivery; a retryable failure
 * backs off and eventually FAILS; and a committed domain event produces the
 * right notifications without the producing transaction ever waiting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { customerIdentities, notificationMessages, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { confirmContactVerification, startContactVerification } from './contact-verification.js';
import { events } from './events.js';
import {
  deliverPendingNotifications,
  enqueueNotification,
  resendNotification,
} from './notifications.js';
import {
  MockEmailProvider,
  MockSmsProvider,
  ResendEmailProvider,
  type EmailProvider,
  type ProviderSendResult,
} from './notification-providers.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];
const mockEmail = new MockEmailProvider();
const mockSms = new MockSmsProvider();

async function makeIdentity(label: string): Promise<{ userId: string; identityId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: label, organizationId })
    .returning();
  users_.push(user!.id);
  const identity = await ensureCustomerIdentity(db, { organizationId, userId: user!.id });
  return { userId: user!.id, identityId: identity.id };
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
});

afterAll(async () => {
  if (users_.length > 0) {
    await db.delete(notificationMessages).where(inArray(notificationMessages.customerIdentityId,
      (await db.select({ id: customerIdentities.id }).from(customerIdentities).where(inArray(customerIdentities.userId, users_))).map((r) => r.id),
    )).catch(() => undefined);
    await db.delete(customerIdentities).where(inArray(customerIdentities.userId, users_)).catch(() => undefined);
    await db.delete(users).where(inArray(users.id, users_)).catch(() => undefined);
  }
  await app.close();
});

describe('enqueue idempotency + channel policy', () => {
  it('records at most one row per (type, channel, subject) — a retry is a no-op', async () => {
    const { identityId } = await makeIdentity('idem');
    const args = {
      organizationId,
      customerIdentityId: identityId,
      type: 'EVAL_PASSED' as const,
      subjectKey: 'qual-1',
      recipientByChannel: { EMAIL: 'x@y.com' },
    };
    const a = await enqueueNotification(db, args);
    const b = await enqueueNotification(db, args);
    expect(a).toBe(1);
    expect(b).toBe(0);
    const rows = await db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'EVAL_PASSED')));
    expect(rows).toHaveLength(1);
  });

  it('applies the channel policy (FUNDED_READY email + sms; PURCHASE_CONFIRMED email only)', async () => {
    const { identityId } = await makeIdentity('policy');
    await enqueueNotification(db, {
      organizationId, customerIdentityId: identityId, type: 'FUNDED_READY', subjectKey: 'f1',
      recipientByChannel: { EMAIL: 'e@y.com', SMS: '+15550001111' },
    });
    await enqueueNotification(db, {
      organizationId, customerIdentityId: identityId, type: 'PURCHASE_CONFIRMED', subjectKey: 'p1',
      recipientByChannel: { EMAIL: 'e@y.com', SMS: '+15550001111' },
    });
    const funded = await db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'FUNDED_READY')));
    const purchase = await db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'PURCHASE_CONFIRMED')));
    expect(new Set(funded.map((r) => r.channel))).toEqual(new Set(['EMAIL', 'SMS']));
    expect(purchase.map((r) => r.channel)).toEqual(['EMAIL']);
  });
});

describe('delivery', () => {
  it('delivers a pending message via the mock provider (SENT)', async () => {
    const { identityId } = await makeIdentity('deliver');
    await enqueueNotification(db, { organizationId, customerIdentityId: identityId, type: 'EVAL_READY', subjectKey: 'e1', recipientByChannel: { EMAIL: 'go@y.com' } });
    await deliverPendingNotifications(db, { email: mockEmail, sms: mockSms });
    const [row] = await db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'EVAL_READY')));
    expect(row!.status).toBe('SENT');
    expect(row!.terminal).toBe(true);
    expect(row!.provider).toBe('MOCK');
    expect(row!.providerRef).toBeTruthy();
  });

  it('SUPPRESSES (not fakes) when the real provider is unconfigured', async () => {
    const { identityId } = await makeIdentity('suppress');
    await enqueueNotification(db, { organizationId, customerIdentityId: identityId, type: 'EVAL_READY', subjectKey: 's1', recipientByChannel: { EMAIL: 'no@y.com' } });
    await deliverPendingNotifications(db, { email: new ResendEmailProvider(), sms: mockSms });
    const [row] = await db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'EVAL_READY')));
    expect(row!.status).toBe('SUPPRESSED');
    expect(row!.terminal).toBe(true);
    expect(row!.lastError).toMatch(/UNCONFIGURED/);
  });

  it('retries a transient failure and eventually FAILS at the cap', async () => {
    const { identityId } = await makeIdentity('retry');
    // Insert directly at attempts = max-1 so one more failure is terminal.
    const [row] = await db.insert(notificationMessages).values({
      organizationId, customerIdentityId: identityId, type: 'EVAL_READY', channel: 'EMAIL',
      recipient: 'r@y.com', dedupeKey: `retry-${crypto.randomUUID()}`, status: 'PENDING',
      attempts: 5, maxAttempts: 6, payload: { subject: 's', body: 'b', to: 'r@y.com' } as object,
    }).returning();
    const flaky: EmailProvider = {
      name: 'RESEND',
      isConfigured: () => true,
      send: async (): Promise<ProviderSendResult> => ({ ok: false, retryable: true, error: 'temporary' }),
    };
    await deliverPendingNotifications(db, { email: flaky, sms: mockSms });
    const [after] = await db.select().from(notificationMessages).where(eq(notificationMessages.id, row!.id));
    expect(after!.status).toBe('FAILED');
    expect(after!.terminal).toBe(true);
    expect(after!.attempts).toBe(6);
  });
});

describe('event consumer', () => {
  it('maps account.funded to a single FUNDED_READY (deduped), addressed to verified contacts', async () => {
    const { userId, identityId } = await makeIdentity('funded-evt');
    // Verify contacts so the recipient resolves.
    const email = await startContactVerification(db, { identityId, channel: 'EMAIL', value: 'fund@y.com' });
    await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
    const sms = await startContactVerification(db, { identityId, channel: 'SMS', value: '+15552223333' });
    await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });

    const accountId = crypto.randomUUID();
    await events.publish(db, { type: 'account.funded', organizationId, userId, accountId, payload: { publicId: 'SIM-1' } });
    await events.publish(db, { type: 'account.funded', organizationId, userId, accountId, payload: { publicId: 'SIM-1' } });

    // The consumer is deferred; wait briefly, then check.
    const seen = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const rows = await db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'FUNDED_READY')));
        if (rows.length >= 2) return rows; // one EMAIL + one SMS
        await new Promise((r) => setTimeout(r, 50));
      }
      return db.select().from(notificationMessages).where(and(eq(notificationMessages.customerIdentityId, identityId), eq(notificationMessages.type, 'FUNDED_READY')));
    })();
    // Exactly one per channel despite two identical events.
    expect(seen.filter((r) => r.channel === 'EMAIL')).toHaveLength(1);
    expect(seen.filter((r) => r.channel === 'SMS')).toHaveLength(1);
  });
});

describe('owner resend', () => {
  it('requeues a notification as a new PENDING message', async () => {
    const { identityId } = await makeIdentity('resend');
    await enqueueNotification(db, { organizationId, customerIdentityId: identityId, type: 'EVAL_READY', subjectKey: 'rs1', recipientByChannel: { EMAIL: 'z@y.com' } });
    const [row] = await db.select().from(notificationMessages).where(eq(notificationMessages.customerIdentityId, identityId));
    const { requeued } = await resendNotification(db, row!.id);
    expect(requeued).toBe(true);
    const rows = await db.select().from(notificationMessages).where(eq(notificationMessages.customerIdentityId, identityId));
    expect(rows.length).toBe(2);
  });
});
