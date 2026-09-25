/**
 * Enforcement service (M7) against the test database. Asserts the durable
 * behaviours: idempotent signal ingestion, a signal is not a case, case
 * correlation folding, the finding rules (rule-breach rejected, NO_VIOLATION
 * clears holds, adverse confirms + is appealable), hold idempotency, information
 * requests with an ownership check, and appeals V1 (independence guard, decision
 * immutability, overturn supersedes but preserves the original finding).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { customerIdentities, enforcementAppeals, enforcementCases, enforcementFindings, enforcementHolds, users } from '../db/schema.js';
import { defaultOrganizationId } from './provisioning.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import {
  appealEligibility, createInformationRequest, decideAppeal, getCase, ingestSignal, openCase,
  placeHold, recordAction, recordFinding, releaseHold, respondToInformationRequest, submitAppeal, transitionCase,
} from './enforcement.js';

const ADMIN = { type: 'ADMIN' as const, userId: '' as string, label: 'op' };
let db: Database;
let sql: ReturnType<typeof createDb>['sql'];
let organizationId: string;
let reviewerA = '';
let reviewerB = '';
const createdUsers: string[] = [];

async function makeOperator(role = 'ADMIN'): Promise<string> {
  const [u] = await db.insert(users).values({ email: `enf-rev-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: role, role, isAdmin: true, organizationId }).returning();
  createdUsers.push(u!.id);
  return u!.id;
}

async function makeIdentity(): Promise<{ userId: string; identityId: string }> {
  const [u] = await db.insert(users).values({ email: `enf-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Enf', organizationId }).returning();
  createdUsers.push(u!.id);
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  return { userId: u!.id, identityId: ident.id };
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  const handle = createDb(url); db = handle.db; sql = handle.sql;
  organizationId = await defaultOrganizationId(db);
  const [op] = await db.insert(users).values({ email: `enf-op-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: 'x', displayName: 'Op', role: 'ADMIN', isAdmin: true, organizationId }).returning();
  ADMIN.userId = op!.id; createdUsers.push(op!.id);
  reviewerA = await makeOperator('ADMIN');
  reviewerB = await makeOperator('SUPER_ADMIN');
});

afterAll(async () => {
  for (const id of createdUsers) {
    await db.delete(customerIdentities).where(eq(customerIdentities.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
  await sql.end({ timeout: 5 });
});

describe('signals', () => {
  it('are idempotent on (org, dedupeKey)', async () => {
    const { identityId } = await makeIdentity();
    const key = `dk-${crypto.randomUUID()}`;
    const a = await ingestSignal(db, { organizationId, source: 'AUTH', kind: 'SECURITY_NEW_DEVICE', dedupeKey: key, customerIdentityId: identityId });
    const b = await ingestSignal(db, { organizationId, source: 'AUTH', kind: 'SECURITY_NEW_DEVICE', dedupeKey: key, customerIdentityId: identityId });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.signal.id).toBe(a.signal.id);
  });

  it('a new-device INFO signal never opens a case, even with a category', async () => {
    const { identityId } = await makeIdentity();
    const r = await ingestSignal(db, { organizationId, source: 'AUTH', kind: 'SECURITY_NEW_DEVICE', dedupeKey: `dk-${crypto.randomUUID()}`, customerIdentityId: identityId, openCaseCategory: 'SECURITY' });
    expect(r.caseId).toBeNull();
  });

  it('a credible takeover report opens a case', async () => {
    const { identityId } = await makeIdentity();
    const r = await ingestSignal(db, { organizationId, source: 'CUSTOMER_REPORT', kind: 'CUSTOMER_REPORTED_ACCESS', dedupeKey: `dk-${crypto.randomUUID()}`, customerIdentityId: identityId, openCaseCategory: 'SECURITY' });
    expect(r.caseId).not.toBeNull();
  });
});

describe('cases', () => {
  it('open with an HTR- public reference', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'IDENTITY', actor: ADMIN });
    expect(c.publicRef).toMatch(/^HTR-[A-Z0-9]{6}$/);
    expect(c.status).toBe('OPEN');
    expect(c.severity).toBe('LOW');
  });

  it('fold onto one correlated case and raise severity', async () => {
    const { identityId } = await makeIdentity();
    const key = `PAYOUT:${identityId}`;
    const first = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'PAYOUT', correlationKey: key, severity: 'LOW', actor: ADMIN });
    const second = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'PAYOUT', correlationKey: key, severity: 'HIGH', actor: ADMIN });
    expect(second.id).toBe(first.id);
    const reread = await getCase(db, first.id);
    expect(reread!.severity).toBe('HIGH');
  });

  it('reject an illegitimate transition', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    await expect(transitionCase(db, { caseId: c.id, to: 'CONFIRMED_VIOLATION', actor: ADMIN })).rejects.toThrow(/Cannot move/i);
  });

  it('reject a stale optimistic version', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    await expect(transitionCase(db, { caseId: c.id, to: 'UNDER_REVIEW', actor: ADMIN, expectedVersion: 999 })).rejects.toThrow(/changed since/i);
  });

  it('carry no numeric fraud/risk score field', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'GENERAL', actor: ADMIN });
    const keys = Object.keys(c).map((k) => k.toLowerCase());
    expect(keys.some((k) => k.includes('score'))).toBe(false);
  });
});

describe('holds', () => {
  it('are idempotent on the idempotency key', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    const key = `hk-${crypto.randomUUID()}`;
    const h1 = await placeHold(db, { organizationId, caseId: c.id, scope: 'CUSTOMER', scopeId: identityId, capability: 'ACCESS', reasonCode: 'MANUAL', idempotencyKey: key, actor: ADMIN });
    const h2 = await placeHold(db, { organizationId, caseId: c.id, scope: 'CUSTOMER', scopeId: identityId, capability: 'ACCESS', reasonCode: 'MANUAL', idempotencyKey: key, actor: ADMIN });
    expect(h2.id).toBe(h1.id);
  });

  it('release is idempotent (second release does not throw)', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    const h = await placeHold(db, { organizationId, caseId: c.id, scope: 'CUSTOMER', scopeId: identityId, capability: 'ACCESS', reasonCode: 'MANUAL', actor: ADMIN });
    const r1 = await releaseHold(db, h.id, { actor: ADMIN });
    const r2 = await releaseHold(db, h.id, { actor: ADMIN });
    expect(r1!.status).toBe('RELEASED');
    expect(r2!.status).toBe('RELEASED');
  });
});

describe('findings — rule breach vs misconduct', () => {
  it('reject a rule-breach code as a finding', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'GENERAL', actor: ADMIN });
    await transitionCase(db, { caseId: c.id, to: 'UNDER_REVIEW', actor: ADMIN });
    await expect(recordFinding(db, { organizationId, caseId: c.id, reasonCode: 'MLL_BREACH' as never, decidedByUserId: ADMIN.userId, actor: ADMIN })).rejects.toThrow(/Unknown finding code|rule breach|misconduct/i);
  });

  it('NO_VIOLATION resolves with no action and releases holds', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    const h = await placeHold(db, { organizationId, caseId: c.id, scope: 'CUSTOMER', scopeId: identityId, capability: 'ACCESS', reasonCode: 'MANUAL', actor: ADMIN });
    await recordFinding(db, { organizationId, caseId: c.id, reasonCode: 'NO_VIOLATION', decidedByUserId: ADMIN.userId, actor: ADMIN });
    const reread = await getCase(db, c.id);
    expect(reread!.status).toBe('RESOLVED_NO_ACTION');
    const [hold] = await db.select().from(enforcementHolds).where(eq(enforcementHolds.id, h.id));
    expect(hold!.status).toBe('RELEASED');
  });

  it('an adverse finding confirms the violation and is appealable', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'ACCOUNT_OWNERSHIP', actor: ADMIN });
    await transitionCase(db, { caseId: c.id, to: 'UNDER_REVIEW', actor: ADMIN });
    const f = await recordFinding(db, { organizationId, caseId: c.id, reasonCode: 'ACCOUNT_SHARING_CONFIRMED', decidedByUserId: ADMIN.userId, actor: ADMIN });
    expect(f.adverse).toBe(true);
    expect(f.appealable).toBe(true);
    const reread = await getCase(db, c.id);
    expect(reread!.status).toBe('CONFIRMED_VIOLATION');
  });
});

describe('actions', () => {
  it('are idempotent on the idempotency key', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    const key = `ak-${crypto.randomUUID()}`;
    const a1 = await recordAction(db, { organizationId, caseId: c.id, actionType: 'REVOKE_SESSIONS', idempotencyKey: key, actor: ADMIN });
    const a2 = await recordAction(db, { organizationId, caseId: c.id, actionType: 'REVOKE_SESSIONS', idempotencyKey: key, actor: ADMIN });
    expect(a1.deduped).toBe(false);
    expect(a2.deduped).toBe(true);
    expect(a2.id).toBe(a1.id);
  });
});

describe('information requests', () => {
  it('move the case to AWAITING_CUSTOMER and enforce ownership on response', async () => {
    const { identityId } = await makeIdentity();
    const other = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'IDENTITY', actor: ADMIN });
    const reqId = await createInformationRequest(db, { caseId: c.id, requestType: 'GENERAL', messageSafe: 'Please confirm your address.', requestedByUserId: ADMIN.userId, actor: ADMIN });
    expect((await getCase(db, c.id))!.status).toBe('AWAITING_CUSTOMER');
    // Another customer cannot answer it (IDOR guard).
    await expect(respondToInformationRequest(db, { requestId: reqId, customerIdentityId: other.identityId, responseText: 'hi' })).rejects.toThrow(/not found/i);
    // The owner can, and it moves back to review.
    await respondToInformationRequest(db, { requestId: reqId, customerIdentityId: identityId, responseText: '742 Evergreen Terrace' });
    expect((await getCase(db, c.id))!.status).toBe('UNDER_REVIEW');
    // A second response is rejected.
    await expect(respondToInformationRequest(db, { requestId: reqId, customerIdentityId: identityId, responseText: 'again' })).rejects.toThrow(/already been answered|already responded/i);
  });
});

describe('appeals V1', () => {
  async function confirmedCase(): Promise<{ identityId: string; userId: string; caseId: string }> {
    const { identityId, userId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'ACCOUNT_OWNERSHIP', actor: ADMIN });
    await transitionCase(db, { caseId: c.id, to: 'UNDER_REVIEW', actor: ADMIN });
    await recordFinding(db, { organizationId, caseId: c.id, reasonCode: 'ACCOUNT_SHARING_CONFIRMED', decidedByUserId: ADMIN.userId, actor: ADMIN });
    return { identityId, userId, caseId: c.id };
  }

  it('are not eligible before an adverse decision', async () => {
    const { identityId } = await makeIdentity();
    const c = await openCase(db, { organizationId, customerIdentityId: identityId, category: 'SECURITY', actor: ADMIN });
    expect((await appealEligibility(db, c.id)).eligible).toBe(false);
  });

  it('are eligible after a confirmed violation and submit moves to APPEALED', async () => {
    const { identityId, userId, caseId } = await confirmedCase();
    expect((await appealEligibility(db, caseId)).eligible).toBe(true);
    const appeal = await submitAppeal(db, { caseId, customerIdentityId: identityId, customerStatement: 'It is my own account.', actor: { type: 'USER' as const, userId } });
    expect(appeal.status).toBe('SUBMITTED');
    expect(appeal.originalDeciderUserId).toBe(ADMIN.userId);
    expect((await getCase(db, caseId))!.status).toBe('APPEALED');
  });

  it('block the same reviewer from deciding without an override (independence guard)', async () => {
    const { identityId, userId, caseId } = await confirmedCase();
    const appeal = await submitAppeal(db, { caseId, customerIdentityId: identityId, customerStatement: 's', actor: { type: 'USER' as const, userId } });
    await expect(decideAppeal(db, { appealId: appeal.id, decision: 'UPHELD', decidedByUserId: ADMIN.userId, actor: ADMIN })).rejects.toThrow(/original reviewer|independence|higher-authority/i);
  });

  it('overturn supersedes but preserves the original finding, releases holds, and closes OVERTURNED', async () => {
    const { identityId, userId, caseId } = await confirmedCase();
    const hold = await placeHold(db, { organizationId, caseId, scope: 'CUSTOMER', scopeId: identityId, capability: 'ACCESS', reasonCode: 'CONTAINMENT', actor: ADMIN });
    const appeal = await submitAppeal(db, { caseId, customerIdentityId: identityId, customerStatement: 's', actor: { type: 'USER' as const, userId } });
    const independent = reviewerA; // a different reviewer id
    await decideAppeal(db, { appealId: appeal.id, decision: 'OVERTURNED', decidedByUserId: independent, customerSafeExplanation: 'Resolved in your favour.', actor: { type: 'ADMIN' as const, userId: independent } });
    expect((await getCase(db, caseId))!.status).toBe('OVERTURNED');
    const [f] = await db.select().from(enforcementFindings).where(eq(enforcementFindings.caseId, caseId));
    expect(f!.status).toBe('SUPERSEDED'); // superseded, not deleted — the original decision is preserved
    const [h] = await db.select().from(enforcementHolds).where(eq(enforcementHolds.id, hold.id));
    expect(h!.status).toBe('RELEASED');
  });

  it('a decided appeal cannot be decided again (immutability)', async () => {
    const { identityId, userId, caseId } = await confirmedCase();
    const appeal = await submitAppeal(db, { caseId, customerIdentityId: identityId, customerStatement: 's', actor: { type: 'USER' as const, userId } });
    const reviewer = reviewerB;
    await decideAppeal(db, { appealId: appeal.id, decision: 'UPHELD', decidedByUserId: reviewer, actor: { type: 'ADMIN' as const, userId: reviewer } });
    await expect(decideAppeal(db, { appealId: appeal.id, decision: 'OVERTURNED', decidedByUserId: reviewer, actor: { type: 'ADMIN' as const, userId: reviewer } })).rejects.toThrow(/already been decided/i);
    // The finding remains ACTIVE (upheld) — the case is FINALIZED.
    const reread = await getCase(db, caseId);
    expect(reread!.status).toBe('FINALIZED');
    const [ap] = await db.select().from(enforcementAppeals).where(eq(enforcementAppeals.id, appeal.id));
    expect(ap!.status).toBe('UPHELD');
  });

  it('only one appeal per case', async () => {
    const { identityId, userId, caseId } = await confirmedCase();
    await submitAppeal(db, { caseId, customerIdentityId: identityId, customerStatement: 's', actor: { type: 'USER' as const, userId } });
    await expect(submitAppeal(db, { caseId, customerIdentityId: identityId, customerStatement: 's2', actor: { type: 'USER' as const, userId } })).rejects.toThrow(/cannot be appealed/i);
  });
});
