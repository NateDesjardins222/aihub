/**
 * Certificates & achievements — issuance, privacy, idempotency, thresholds and
 * the public verification projection, against the real database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../http/app.js';
import { getDb } from '../db/client.js';
import { certificates, customerIdentities, payoutRequests, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from './profiles.js';
import {
  issueCertificate,
  publicVerification,
  revokeCertificate,
  safePublicDisplayName,
  listCertificatesForUser,
} from './certificates.js';
import {
  cumulativeTraderShareMicros,
  issueAchievement,
  listAchievementsForUser,
  setAchievementsPublic,
} from './achievements.js';
import { applyRecognition } from './recognition.js';

const M = 1_000_000;
let app: FastifyInstance;
let db: ReturnType<typeof getDb>['db'];
let organizationId: string;
const users_: string[] = [];

const FUNDED_KEY = `recog-fund-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(label: string, displayName: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName, organizationId })
    .returning();
  users_.push(u!.id);
  return u!.id;
}

async function fundedAccount(userId: string): Promise<string> {
  const product = await resolveProfileByKey(db, organizationId, FUNDED_KEY);
  const r = await provisionAccount(db, { organizationId, userId, profileVersionId: product.versionId, activate: true });
  return r.accountId;
}

async function seedPaidPayout(userId: string, accountId: string, traderShareMicros: number, state = 'PAID'): Promise<string> {
  const [row] = await db
    .insert(payoutRequests)
    .values({ organizationId, accountId, userId, requestedGrossMicros: traderShareMicros, traderShareMicros, state } as never)
    .returning();
  return (row as { id: string }).id;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['HTF_AUTO_FUNDING'] = 'false';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, {
    organizationId, key: FUNDED_KEY, name: 'Recog Funded 50K', accountType: 'FUNDED_SIM',
    config: {
      rules: {
        accountSizeMicros: 50_000 * M, profitTargetMicros: 0, maxLossMicros: 2_000 * M,
        drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null,
        dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null,
        minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true,
      },
      execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
      display: { startingBalanceMicros: 50_000 * M }, payoutRules: null, fundedDestinationKey: null,
    },
  });
});

afterAll(async () => {
  if (users_.length > 0) {
    // certificates.account_id has no cascade, so drop certificates (by identity)
    // before the user delete cascades the accounts they reference.
    const idents = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(inArray(customerIdentities.userId, users_));
    const identIds = idents.map((i) => i.id);
    if (identIds.length > 0) await db.delete(certificates).where(inArray(certificates.customerIdentityId, identIds));
    await db.delete(users).where(inArray(users.id, users_));
  }
  await app.close();
});

describe('safePublicDisplayName', () => {
  it('prefers a chosen name, else first + last initial, never an email or full legal name', () => {
    expect(safePublicDisplayName('Ace Trader', 'Nathan Desjardins')).toBe('Ace Trader');
    expect(safePublicDisplayName(null, 'Nathan Desjardins')).toBe('Nathan D.');
    expect(safePublicDisplayName(null, 'nathan@example.com')).toBe('nathan'); // no @ leaked
    expect(safePublicDisplayName(null, '')).toBe('Happy Trader');
    expect(safePublicDisplayName(null, 'Cher')).toBe('Cher');
  });
});

describe('certificate issuance + public verification', () => {
  it('issues exactly once per dedupe key and verifies with only safe fields', async () => {
    const userId = await makeUser('cert', 'Nathan Desjardins');
    const c1 = await issueCertificate(db, { organizationId, userId, accountId: null, type: 'FUNDED_TRADER', dedupeKey: `funded:${userId}` });
    const c2 = await issueCertificate(db, { organizationId, userId, accountId: null, type: 'FUNDED_TRADER', dedupeKey: `funded:${userId}` });
    expect(c1!.id).toBe(c2!.id); // idempotent

    const rows = await db.select().from(certificates).where(eq(certificates.dedupeKey, `funded:${userId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.publicDisplayName).toBe('Nathan D.'); // safe name, not legal

    const pub = await publicVerification(db, c1!.verificationToken);
    expect(pub.valid).toBe(true);
    expect(pub.status).toBe('ISSUED');
    expect(pub.publicDisplayName).toBe('Nathan D.');
    expect(pub.certificatePublicId).toMatch(/^HT-C-/);
    // The projection carries no legal-identity fields at all.
    expect(Object.keys(pub)).toEqual(
      expect.arrayContaining(['valid', 'status', 'certificatePublicId', 'type', 'publicDisplayName', 'amountMicros', 'issuedMonth']),
    );
    expect(JSON.stringify(pub)).not.toContain('@atlas.test');
  });

  it('an unknown token is UNKNOWN/invalid; a revoked one is REVOKED/invalid', async () => {
    const userId = await makeUser('revoke', 'Sam Smith');
    const c = await issueCertificate(db, { organizationId, userId, accountId: null, type: 'PAYOUT', dedupeKey: `payout:${userId}`, amountMicros: 900 * M });
    expect((await publicVerification(db, 'no-such-token')).status).toBe('UNKNOWN');
    await revokeCertificate(db, c!.id, 'test');
    const pub = await publicVerification(db, c!.verificationToken);
    expect(pub.valid).toBe(false);
    expect(pub.status).toBe('REVOKED');
  });

  it('lists a trader’s own certificates', async () => {
    const userId = await makeUser('list', 'Lee Long');
    await issueCertificate(db, { organizationId, userId, accountId: null, type: 'EVALUATION_PASSED', dedupeKey: `pass:${userId}` });
    const list = await listCertificatesForUser(db, userId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.type).toBe('EVALUATION_PASSED');
  });
});

describe('achievements', () => {
  it('issues exactly once and respects the visibility toggle', async () => {
    const userId = await makeUser('ach', 'Ana Ng');
    const key = `funded:${userId}`; // dedupe is (org, key), so scope to the trader
    expect(await issueAchievement(db, { organizationId, userId, type: 'FUNDED', dedupeKey: key })).toBe(true);
    expect(await issueAchievement(db, { organizationId, userId, type: 'FUNDED', dedupeKey: key })).toBe(false);
    const listed = await listAchievementsForUser(db, userId);
    expect(listed.achievements.filter((a) => (a as { type: string }).type === 'FUNDED')).toHaveLength(1);
    expect(listed.achievementsPublic).toBe(false);
    await setAchievementsPublic(db, userId, true);
    expect((await listAchievementsForUser(db, userId)).achievementsPublic).toBe(true);
  });

  it('cumulative trader share counts PAID payouts only', async () => {
    const userId = await makeUser('cum', 'Cody Cash');
    const accountId = await fundedAccount(userId);
    // Two PAID (5k + 8k) and one non-paid (should not count).
    await seedPaidPayout(userId, accountId, 5_000 * M, 'PAID');
    await seedPaidPayout(userId, accountId, 8_000 * M, 'PAID');
    await seedPaidPayout(userId, accountId, 9_000 * M, 'APPROVED');
    expect(await cumulativeTraderShareMicros(db, userId)).toBe(13_000 * M);
  }, 30000);
});

describe('recognition handler (event-driven, idempotent)', () => {
  it('payout.paid issues a PAYOUT certificate and the crossed cumulative thresholds', async () => {
    const userId = await makeUser('recog', 'Ravi Rao');
    const accountId = await fundedAccount(userId);
    // Seed a PAID payout request and drive the handler with its event.
    const reqId = await seedPaidPayout(userId, accountId, 12_000 * M, 'PAID');

    await applyRecognition(db, {
      type: 'payout.paid', organizationId, userId, accountId,
      payload: { payoutRequestId: reqId },
    });

    const certs = await listCertificatesForUser(db, userId);
    expect(certs.some((c) => c.type === 'PAYOUT')).toBe(true);
    const ach = (await listAchievementsForUser(db, userId)).achievements.map((a) => (a as { type: string }).type);
    expect(ach).toContain('FIRST_PAYOUT');
    expect(ach).toContain('PAID_5K');
    expect(ach).toContain('PAID_10K');
    expect(ach).not.toContain('PAID_25K'); // 12k < 25k

    // Idempotent: replaying the same event issues nothing new.
    await applyRecognition(db, { type: 'payout.paid', organizationId, userId, accountId, payload: { payoutRequestId: reqId } });
    const certs2 = await listCertificatesForUser(db, userId);
    expect(certs2.filter((c) => c.type === 'PAYOUT')).toHaveLength(1);
  }, 30000);
});
