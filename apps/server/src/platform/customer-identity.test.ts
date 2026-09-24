/**
 * Customer identity spine — the state machine (pure) and the CRUD/transition
 * service against the real database. "Email is not the person": the identity is
 * keyed by user, not email, and its status only moves through legal transitions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { customerIdentities, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId } from './provisioning.js';
import {
  IdentityError,
  advanceIdentityStatus,
  canTransitionIdentity,
  ensureCustomerIdentity,
  getIdentityByUser,
  updateIdentityInfo,
} from './customer-identity.js';

let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];

async function makeUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`,
      passwordHash: await hashPassword('identity-test-password'),
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
});

afterAll(async () => {
  if (users_.length > 0) {
    await db.delete(customerIdentities).where(inArray(customerIdentities.userId, users_));
    await db.delete(users).where(inArray(users.id, users_));
  }
  await app.close();
});

describe('canTransitionIdentity (pure state machine)', () => {
  it('allows the forward path and idempotent same-state', () => {
    expect(canTransitionIdentity('UNVERIFIED', 'CONTACT_PENDING')).toBe(true);
    expect(canTransitionIdentity('CONTACT_PENDING', 'CONTACT_VERIFIED')).toBe(true);
    expect(canTransitionIdentity('CONTACT_VERIFIED', 'IDENTITY_PENDING')).toBe(true);
    expect(canTransitionIdentity('IDENTITY_PENDING', 'IDENTITY_VERIFIED')).toBe(true);
    expect(canTransitionIdentity('IDENTITY_PENDING', 'UNDER_REVIEW')).toBe(true);
    expect(canTransitionIdentity('UNDER_REVIEW', 'IDENTITY_VERIFIED')).toBe(true);
    expect(canTransitionIdentity('REJECTED', 'IDENTITY_PENDING')).toBe(true);
    expect(canTransitionIdentity('IDENTITY_VERIFIED', 'IDENTITY_VERIFIED')).toBe(true);
  });

  it('refuses skips and illegal regressions', () => {
    expect(canTransitionIdentity('UNVERIFIED', 'IDENTITY_VERIFIED')).toBe(false);
    expect(canTransitionIdentity('CONTACT_VERIFIED', 'IDENTITY_VERIFIED')).toBe(false);
    expect(canTransitionIdentity('IDENTITY_VERIFIED', 'CONTACT_VERIFIED')).toBe(false);
    expect(canTransitionIdentity('REJECTED', 'IDENTITY_VERIFIED')).toBe(false);
  });
});

describe('ensureCustomerIdentity', () => {
  it('creates exactly one identity and is idempotent per user', async () => {
    const userId = await makeUser('spine');
    const first = await ensureCustomerIdentity(db, { organizationId, userId });
    const second = await ensureCustomerIdentity(db, { organizationId, userId });
    expect(first.id).toBe(second.id);
    expect(first.identityStatus).toBe('UNVERIFIED');
    const byUser = await getIdentityByUser(db, organizationId, userId);
    expect(byUser?.id).toBe(first.id);
  });

  it('is safe under concurrent creation (one row wins)', async () => {
    const userId = await makeUser('race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureCustomerIdentity(db, { organizationId, userId })),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
  });
});

describe('advanceIdentityStatus', () => {
  it('applies a legal transition and refuses an illegal one', async () => {
    const userId = await makeUser('advance');
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    const moved = await advanceIdentityStatus(db, { identityId: identity.id, to: 'CONTACT_PENDING' });
    expect(moved.identityStatus).toBe('CONTACT_PENDING');

    await expect(
      advanceIdentityStatus(db, { identityId: identity.id, to: 'IDENTITY_VERIFIED' }),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' } satisfies Partial<IdentityError>);

    // Idempotent same-state is a no-op, not an error.
    const same = await advanceIdentityStatus(db, { identityId: identity.id, to: 'CONTACT_PENDING' });
    expect(same.identityStatus).toBe('CONTACT_PENDING');
  });

  it('captures identity info without changing status', async () => {
    const userId = await makeUser('info');
    const identity = await ensureCustomerIdentity(db, { organizationId, userId });
    const updated = await updateIdentityInfo(db, {
      identityId: identity.id,
      legalName: 'Jordan Rivera',
      dateOfBirth: '1990-01-15',
      country: 'US',
    });
    expect(updated.legalName).toBe('Jordan Rivera');
    expect(updated.country).toBe('US');
    expect(updated.identityStatus).toBe('UNVERIFIED');
  });
});
