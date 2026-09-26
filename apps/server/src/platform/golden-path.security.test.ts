/**
 * PHASE 5 — Golden Path ownership + active-account-cap boundaries (PARTS 34/35).
 *
 * These are the failure/ownership invariants the lifecycle harness does not cover
 * inline: the 5-active-account cap per identity, and cross-customer isolation
 * (customer A cannot read customer B's account). Server-authoritative RBAC
 * (trader → owner payout APIs = 403) is proven separately in the HTTP admin/auth
 * suites; the money exactly-once invariants are in golden-path.core50k.test.ts.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { reconcileHtfProducts } from './product-reconcile.js';
import { AccountLimitError, countActiveAccounts, MAX_ACTIVE_ACCOUNTS } from './account-limit.js';
import { portalAccountDetail, PortalAccountError } from './portal-accounts.js';

const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';
let db: Database;
let sqlEnd: () => Promise<void>;
let organizationId: string;

beforeAll(async () => {
  const h = createDb(URL);
  db = h.db;
  sqlEnd = () => h.sql.end({ timeout: 5 });
  organizationId = await defaultOrganizationId(db);
  await reconcileHtfProducts(db, organizationId);
});
afterAll(async () => { await sqlEnd?.(); });

async function makeUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `gp-sec-${crypto.randomUUID().slice(0, 8)}@sec.test`, passwordHash: await hashPassword('pw'), displayName: 'Sec', organizationId })
    .returning();
  return u!.id;
}

describe('Golden Path — ownership + active-account cap', () => {
  it('enforces the 5-active-account cap per identity; the 6th is refused', async () => {
    const userId = await makeUser();
    for (let i = 0; i < MAX_ACTIVE_ACCOUNTS; i += 1) {
      await provisionAccount(db, { organizationId, userId, profileKey: 'htf-core-50k', activate: true, enforceActiveLimit: true, idempotencyKey: `cap-${userId}-${i}` });
    }
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS);
    await expect(
      provisionAccount(db, { organizationId, userId, profileKey: 'htf-core-50k', activate: true, enforceActiveLimit: true, idempotencyKey: `cap-${userId}-6` }),
    ).rejects.toBeInstanceOf(AccountLimitError);
    expect(await countActiveAccounts(db, userId)).toBe(MAX_ACTIVE_ACCOUNTS); // still 5, never 6
  });

  it('a customer cannot read another customer’s account (cross-customer isolation)', async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const { accountId } = await provisionAccount(db, { organizationId, userId: owner, profileKey: 'htf-core-50k', activate: true });
    // The rightful owner can read it.
    const detail = await portalAccountDetail(db, owner, accountId);
    expect(detail.id).toBe(accountId);
    // Another customer cannot — scoped by userId, returns ACCOUNT_NOT_FOUND (no leak).
    await expect(portalAccountDetail(db, intruder, accountId)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await expect(portalAccountDetail(db, intruder, accountId)).rejects.toBeInstanceOf(PortalAccountError);
  });
});
