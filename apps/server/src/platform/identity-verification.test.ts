/**
 * Contact + identity verification against the real database, driven by the
 * deterministic mock provider. Verified contact is not verified identity; the
 * identity state machine only advances through the provider's decision; and the
 * Stripe seam reports itself unconfigured rather than faking a result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { customerIdentities, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import {
  ContactVerificationError,
  confirmContactVerification,
  primaryContactsVerified,
  startContactVerification,
} from './contact-verification.js';
import {
  IdentityVerificationError,
  resolveIdentityVerification,
  startIdentityVerification,
} from './identity-verification.js';
import { MockIdentityProvider, StripeIdentityProvider } from './identity-providers.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: await hashPassword('idv-test-password'),
      displayName: label,
      organizationId,
    })
    .returning();
  users_.push(user!.id);
  return user!.id;
}

async function newIdentity(label: string): Promise<string> {
  const userId = await makeUser(label);
  const identity = await ensureCustomerIdentity(db, { organizationId, userId });
  return identity.id;
}

/** Verify both a primary email and phone so the identity reaches CONTACT_VERIFIED. */
async function verifyBothContacts(identityId: string): Promise<void> {
  const email = await startContactVerification(db, {
    identityId,
    channel: 'EMAIL',
    value: 'buyer@example.com',
  });
  await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
  const sms = await startContactVerification(db, {
    identityId,
    channel: 'SMS',
    value: '+15551234567',
  });
  await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });
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
  if (users_.length > 0) {
    await db.delete(customerIdentities).where(inArray(customerIdentities.userId, users_));
    await db.delete(users).where(inArray(users.id, users_));
  }
  await app.close();
});

describe('contact verification', () => {
  it('verifies a contact with the right code and marks it primary', async () => {
    const identityId = await newIdentity('contact-ok');
    const { challengeId, devCode } = await startContactVerification(db, {
      identityId,
      channel: 'EMAIL',
      value: 'Person@Example.com',
    });
    expect(devCode).toMatch(/^\d{6}$/);
    const res = await confirmContactVerification(db, { challengeId, code: devCode! });
    expect(res.verified).toBe(true);
    const contacts = await primaryContactsVerified(db, identityId);
    expect(contacts.email).toBe(true);
    expect(contacts.sms).toBe(false);
  });

  it('rejects a wrong code and, after the cap, voids the challenge', async () => {
    const identityId = await newIdentity('contact-bad');
    const { challengeId } = await startContactVerification(db, {
      identityId,
      channel: 'EMAIL',
      value: 'a@b.com',
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        confirmContactVerification(db, { challengeId, code: '000000' }),
      ).rejects.toMatchObject({ code: 'INVALID_CODE' } satisfies Partial<ContactVerificationError>);
    }
    await expect(
      confirmContactVerification(db, { challengeId, code: '000000' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' } satisfies Partial<ContactVerificationError>);
  });

  it('advances the identity to CONTACT_VERIFIED once email and phone are both verified', async () => {
    const identityId = await newIdentity('contact-both');
    await verifyBothContacts(identityId);
    const [row] = await db
      .select()
      .from(customerIdentities)
      .where(inArray(customerIdentities.id, [identityId]));
    expect(row?.identityStatus).toBe('CONTACT_VERIFIED');
  });
});

describe('identity verification (mock provider)', () => {
  it('requires contact verification before identity can start', async () => {
    const identityId = await newIdentity('idv-nocontact');
    await expect(
      startIdentityVerification(db, { identityId, legalName: 'Alex Doe' }),
    ).rejects.toMatchObject({ code: 'CONTACT_REQUIRED' } satisfies Partial<IdentityVerificationError>);
  });

  it('drives a clean verification to IDENTITY_VERIFIED', async () => {
    const identityId = await newIdentity('idv-ok');
    await verifyBothContacts(identityId);
    const started = await startIdentityVerification(db, {
      identityId,
      legalName: 'Alex Doe',
      dob: '1988-04-02',
      country: 'US',
    });
    expect(started.status).toBe('IDENTITY_PENDING');
    const resolved = await resolveIdentityVerification(db, { identityId });
    expect(resolved.status).toBe('IDENTITY_VERIFIED');
    const [row] = await db
      .select()
      .from(customerIdentities)
      .where(inArray(customerIdentities.id, [identityId]));
    expect(row?.identityStatus).toBe('IDENTITY_VERIFIED');
  });

  it('routes a REVIEW name to UNDER_REVIEW (not a fraud conviction)', async () => {
    const identityId = await newIdentity('idv-review');
    await verifyBothContacts(identityId);
    await startIdentityVerification(db, { identityId, legalName: 'Sam REVIEW Case' });
    const resolved = await resolveIdentityVerification(db, { identityId });
    expect(resolved.status).toBe('UNDER_REVIEW');
  });

  it('routes a REJECT name to REJECTED (appealable, terminal for this attempt)', async () => {
    const identityId = await newIdentity('idv-reject');
    await verifyBothContacts(identityId);
    await startIdentityVerification(db, { identityId, legalName: 'REJECT Me' });
    const resolved = await resolveIdentityVerification(db, { identityId });
    expect(resolved.status).toBe('REJECTED');
  });

  it('resolving twice is idempotent', async () => {
    const identityId = await newIdentity('idv-twice');
    await verifyBothContacts(identityId);
    await startIdentityVerification(db, { identityId, legalName: 'Idem Potent' });
    const a = await resolveIdentityVerification(db, { identityId });
    const b = await resolveIdentityVerification(db, { identityId });
    expect(a.status).toBe('IDENTITY_VERIFIED');
    expect(b.status).toBe('IDENTITY_VERIFIED');
  });
});

describe('provider seams', () => {
  it('the mock provider reports itself configured', () => {
    expect(new MockIdentityProvider().isConfigured()).toBe(true);
  });

  it('the Stripe provider reports itself unconfigured (no credentials) and never fakes a result', async () => {
    const stripe = new StripeIdentityProvider();
    expect(stripe.isConfigured()).toBe(false);
    await expect(
      stripe.createVerification({ identityId: 'x', legalName: 'Real Person' }),
    ).rejects.toThrow(/not configured/i);
  });
});
