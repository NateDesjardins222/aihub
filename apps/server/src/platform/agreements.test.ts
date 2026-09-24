/**
 * Versioned agreements + the provisioning gate, against the real database.
 * Acceptance is immutable and per-version; a new required version reopens the
 * requirement; and the gate combines identity + contact + agreements into one
 * read-only predicate with no side effects on the trading authority.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { agreementAcceptances, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import {
  acceptAgreements,
  currentAgreementVersions,
  outstandingAgreements,
  publishAgreementVersion,
  seedDefaultAgreements,
} from './agreements.js';
import { evaluateProvisioningGate } from './provisioning-gate.js';
import { confirmContactVerification, startContactVerification } from './contact-verification.js';
import { resolveIdentityVerification, startIdentityVerification } from './identity-verification.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: await hashPassword('agreements-test-password'),
      displayName: label,
      organizationId,
    })
    .returning();
  users_.push(user!.id);
  return user!.id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await seedDefaultAgreements(db, organizationId);
});

afterAll(async () => {
  // agreement_acceptances is append-only (a trigger rejects DELETE), and it
  // cascades from customer_identities — so deleting the test identities would be
  // blocked by that trigger. In production these rows are never deleted; in the
  // test DB we leave them (random emails/identities never collide across runs).
  await app.close();
});

describe('agreement versions', () => {
  it('seeds the four required agreements and is idempotent', async () => {
    await seedDefaultAgreements(db, organizationId);
    const current = await currentAgreementVersions(db, organizationId);
    const types = new Set(current.map((v) => v.agreementType));
    expect(types.has('TERMS_OF_USE')).toBe(true);
    expect(types.has('TRADER_PLEDGE')).toBe(true);
    expect(types.has('PRIVACY')).toBe(true);
    expect(types.has('RISK_DISCLOSURE')).toBe(true);
    // The dev placeholder must be honestly labelled.
    const terms = current.find((v) => v.agreementType === 'TERMS_OF_USE');
    expect(terms?.body).toMatch(/DEVELOPMENT PLACEHOLDER/);
  });

  it('is idempotent on identical content and bumps version on a change', async () => {
    // A synthetic, non-required type in the default org: agreement_versions is
    // append-only (no cleanup possible) and a non-required type never affects the
    // provisioning gate, so leaving these rows is safe and isolated.
    const TYPE = `TEST_${crypto.randomUUID().slice(0, 8)}` as never;
    const v1a = await publishAgreementVersion(db, {
      organizationId,
      agreementType: TYPE,
      title: 'Synthetic',
      body: 'BODY ONE',
      isRequired: false,
    });
    const v1b = await publishAgreementVersion(db, {
      organizationId,
      agreementType: TYPE,
      title: 'Synthetic',
      body: 'BODY ONE',
      isRequired: false,
    });
    expect(v1a.id).toBe(v1b.id);
    expect(v1a.version).toBe(1);
    const v2 = await publishAgreementVersion(db, {
      organizationId,
      agreementType: TYPE,
      title: 'Synthetic',
      body: 'BODY TWO',
      isRequired: false,
      requiresReacceptance: true,
    });
    expect(v2.version).toBe(2);
  });

  it('rejects UPDATE on an acceptance (append-only)', async () => {
    const userId = await makeUser('agr-immutable');
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    const outstanding = await outstandingAgreements(db, organizationId, identity.id);
    await acceptAgreements(db, {
      organizationId,
      identityId: identity.id,
      userId,
      versionIds: outstanding.map((o) => o.versionId),
    });
    // The trigger rejects the UPDATE (drizzle wraps the message, so assert it
    // throws and that the row is unchanged — the real proof of immutability).
    await expect(
      db
        .update(agreementAcceptances)
        .set({ contentHash: 'tampered' })
        .where(eq(agreementAcceptances.customerIdentityId, identity.id)),
    ).rejects.toThrow();
    const [row] = await db
      .select()
      .from(agreementAcceptances)
      .where(eq(agreementAcceptances.customerIdentityId, identity.id))
      .limit(1);
    expect(row?.contentHash).not.toBe('tampered');
  });
});

describe('outstanding + acceptance', () => {
  it('lists all required agreements outstanding, then none after acceptance', async () => {
    const userId = await makeUser('agr-accept');
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    const before = await outstandingAgreements(db, organizationId, identity.id);
    expect(before.length).toBe(4);
    const res = await acceptAgreements(db, {
      organizationId,
      identityId: identity.id,
      userId,
      versionIds: before.map((o) => o.versionId),
      sessionMeta: { ip: '203.0.113.5' },
    });
    expect(res.accepted).toBe(4);
    const after = await outstandingAgreements(db, organizationId, identity.id);
    expect(after.length).toBe(0);
  });

  it('is a no-op on a double acceptance', async () => {
    const userId = await makeUser('agr-double');
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    const outstanding = await outstandingAgreements(db, organizationId, identity.id);
    await acceptAgreements(db, {
      organizationId,
      identityId: identity.id,
      userId,
      versionIds: outstanding.map((o) => o.versionId),
    });
    const second = await acceptAgreements(db, {
      organizationId,
      identityId: identity.id,
      userId,
      versionIds: outstanding.map((o) => o.versionId),
    });
    expect(second.accepted).toBe(0);
  });
});

describe('provisioning gate', () => {
  it('blocks a fresh user on identity, contact, and agreements', async () => {
    const userId = await makeUser('gate-blocked');
    const gate = await evaluateProvisioningGate(db, organizationId, userId);
    expect(gate.satisfied).toBe(false);
    expect(gate.identityOk).toBe(false);
    expect(gate.contactOk).toBe(false);
    expect(gate.agreementsOk).toBe(false);
    expect(gate.blockedReasons).toContain('AGREEMENT_MISSING:TERMS_OF_USE');
  });

  it('is satisfied once contact, identity, and agreements are all complete', async () => {
    const userId = await makeUser('gate-ok');
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    // Contacts
    const email = await startContactVerification(db, { identityId: identity.id, channel: 'EMAIL', value: 'g@ok.com' });
    await confirmContactVerification(db, { challengeId: email.challengeId, code: email.devCode! });
    const sms = await startContactVerification(db, { identityId: identity.id, channel: 'SMS', value: '+15559990000' });
    await confirmContactVerification(db, { challengeId: sms.challengeId, code: sms.devCode! });
    // Identity
    await startIdentityVerification(db, { identityId: identity.id, legalName: 'Gate Ok' });
    await resolveIdentityVerification(db, { identityId: identity.id });
    // Agreements
    const outstanding = await outstandingAgreements(db, organizationId, identity.id);
    await acceptAgreements(db, {
      organizationId,
      identityId: identity.id,
      userId,
      versionIds: outstanding.map((o) => o.versionId),
    });

    const gate = await evaluateProvisioningGate(db, organizationId, userId);
    expect(gate.identityOk).toBe(true);
    expect(gate.contactOk).toBe(true);
    expect(gate.agreementsOk).toBe(true);
    expect(gate.satisfied).toBe(true);
    expect(gate.blockedReasons).toEqual([]);
  });
});
