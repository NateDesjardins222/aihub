/**
 * Randomized concurrent torture harness for the commercial account lifecycle.
 *
 * A seeded pseudo-random stream drives many traders through the whole lifecycle
 * - acquire, pass, fund, fail, decline - with the idempotency-sensitive steps
 * fired CONCURRENTLY (a double-clicked purchase, two owners approving the same
 * qualification at once, a retried grant), because the guarantees under test are
 * exactly the ones concurrency breaks. After every batch, and at the end, the
 * invariants that must never break however the operations interleave are
 * re-checked against the real database:
 *
 *   I1. exactly one account per consumed entitlement (no double provisioning)
 *   I2. exactly one funded account per FUNDED qualification (no double funding)
 *   I3. no evaluation is mutated into a funded account (distinct ids, types kept)
 *   I4. terminal-after-pass: a qualified evaluation is frozen PASSED+QUALIFIED
 *       and never reverts
 *   I5. at most one qualification per (account, lifecycle)
 *   I6. every funded account links back to its source qualification and account
 *   I7. every balance is a finite integer number of micro-dollars
 *   I8. no qualification leaks across the organisation boundary
 *
 * A single violation prints the seed, the batch and the offending row, and
 * exits non-zero. No money moves anywhere in the harness.
 *
 * Run: TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test \
 *      pnpm --filter @atlas/server exec tsx scripts/torture-commercial-lifecycle.ts --seed 1 --traders 60
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Database } from '../src/db/client.js';
import {
  accountQualifications,
  accounts,
  entitlements,
  organizations,
  users,
} from '../src/db/schema.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';
import { publishProfileVersion } from '../src/platform/profiles.js';
import {
  acquireEvaluation,
  approveFunding,
  certifyEvaluation,
  declineFunding,
} from '../src/platform/commerce.js';

const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
const M = 1_000_000;

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function config(fundedKey: string | null) {
  return {
    rules: {
      accountSizeMicros: 50_000 * M,
      profitTargetMicros: 3_000 * M,
      maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC',
      trailingLockAtMicros: null,
      dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY',
      consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      consistencyThreshold: null,
      minTradingDays: 0,
      minWinningDays: 0,
      maxTradingDays: null,
      minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1,
      maxContracts: 10,
      microsCountAsFraction: true,
      flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 10, perInstrument: {} },
    display: { startingBalanceMicros: 50_000 * M },
    payoutRules: null,
    fundedDestinationKey: fundedKey,
  };
}

interface Violation {
  code: string;
  detail: string;
}

async function main(): Promise<void> {
  const seed = Number(arg('seed', '1'));
  const traderCount = Number(arg('traders', '60'));
  const rng = makeRng(seed);
  const { db, sql } = createDb(URL);
  const created: string[] = [];
  const violations: Violation[] = [];
  const fail = (code: string, detail: string): void => {
    violations.push({ code, detail });
    console.error(`  VIOLATION ${code}: ${detail}`);
  };

  try {
    const organizationId = await defaultOrganizationId(db);
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `tort-other-${randomUUID().slice(0, 6)}`, name: 'Torture Other Firm' })
      .returning();
    const FUNDED_KEY = `tort-funded-${randomUUID().slice(0, 6)}`;
    const EVAL_KEY = `tort-eval-${randomUUID().slice(0, 6)}`;
    await publishProfileVersion(db, {
      organizationId,
      key: FUNDED_KEY,
      name: 'Torture Funded 50K',
      accountType: 'FUNDED_SIM',
      config: config(null),
    });
    const evalProfile = await publishProfileVersion(db, {
      organizationId,
      key: EVAL_KEY,
      name: 'Torture Evaluation 50K',
      accountType: 'EVALUATION',
      config: config(FUNDED_KEY),
    });

    async function makeUser(label: string): Promise<string> {
      const [u] = await db
        .insert(users)
        .values({
          email: `tort-${label}-${randomUUID().slice(0, 8)}@atlas.test`,
          passwordHash: 'not-used',
          displayName: label,
          organizationId,
        })
        .returning();
      created.push(u!.id);
      return u!.id;
    }

    // One trader's whole randomized lifecycle. Idempotency-sensitive steps are
    // fired concurrently on purpose.
    async function runTrader(i: number): Promise<void> {
      const userId = await makeUser(`t${i}`);
      const idem = `tort-order-${randomUUID()}`;
      const acquireOnce = () =>
        acquireEvaluation(db, {
          organizationId,
          userId,
          productVersionId: evalProfile.versionId,
          source: rng() < 0.5 ? 'PURCHASE' : 'ADMIN_GRANT',
          idempotencyKey: idem,
        });

      // A double-clicked purchase: two concurrent acquisitions, same key.
      const [a1, a2] = await Promise.all([acquireOnce(), rng() < 0.6 ? acquireOnce() : acquireOnce()]);
      if (a1.accountId !== a2.accountId) fail('I1', `two accounts for one order key: ${a1.accountId} ${a2.accountId}`);
      const accountId = a1.accountId;

      const roll = rng();
      if (roll < 0.5) {
        // Pass -> certify (concurrently, to stress the qualification unique key).
        await db
          .update(accounts)
          .set({ balanceMicros: 50_000 * M + 3_500 * M, highWaterMarkMicros: 50_000 * M + 3_500 * M })
          .where(eq(accounts.id, accountId));
        const [q1, q2] = await Promise.all([
          certifyEvaluation(db, accountId).catch(() => null),
          certifyEvaluation(db, accountId).catch(() => null),
        ]);
        const qid = q1?.id ?? q2?.id;
        if (!qid) {
          fail('CERT', `pass did not certify account ${accountId}`);
          return;
        }
        if (q1 && q2 && q1.id !== q2.id) fail('I5', `two qualifications for one account ${accountId}`);

        const decision = rng();
        if (decision < 0.7) {
          // Two owners approve at once.
          const [f1, f2] = await Promise.all([
            approveFunding(db, qid).catch((e) => ({ error: String(e) }) as never),
            approveFunding(db, qid).catch((e) => ({ error: String(e) }) as never),
          ]);
          const ids = [f1, f2]
            .filter((r): r is { fundedAccountId: string; reused: boolean } => 'fundedAccountId' in r)
            .map((r) => r.fundedAccountId);
          if (new Set(ids).size > 1) fail('I2', `two funded accounts for qualification ${qid}: ${ids.join(', ')}`);
        } else {
          await declineFunding(db, qid, 'torture decline', { type: 'ADMIN', label: 'tort' });
        }
      } else if (roll < 0.8) {
        // Fail: the engine breached it. Certification must refuse.
        await db
          .update(accounts)
          .set({ status: 'FAILED', ruleStatus: 'FAILED', failedReason: 'MAX_LOSS_LIMIT' })
          .where(eq(accounts.id, accountId));
        const q = await certifyEvaluation(db, accountId).catch(() => null);
        if (q) fail('FAIL', `certified a failed account ${accountId}`);
      }
      // else: left ACTIVE, still in evaluation.
    }

    // Run traders in concurrent batches.
    const batchSize = 12;
    for (let start = 0; start < traderCount; start += batchSize) {
      const batch = [];
      for (let i = start; i < Math.min(start + batchSize, traderCount); i += 1) batch.push(runTrader(i));
      await Promise.all(batch);
      await checkInvariants(db, created, organizationId, otherOrg!.id, fail);
      console.log(`  batch ${start / batchSize + 1}: ${created.length} traders, ${violations.length} violations so far`);
    }

    await checkInvariants(db, created, organizationId, otherOrg!.id, fail);

    console.log('\n=== commercial lifecycle torture ===');
    console.log(`seed=${seed} traders=${traderCount}`);
    console.log(`${violations.length} invariant violations`);
    console.log(violations.length === 0 ? 'ALL INVARIANTS HELD' : 'VIOLATIONS PRESENT');
    process.exitCode = violations.length === 0 ? 0 : 1;
  } finally {
    for (const userId of created) {
      const owned = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
      for (const a of owned) {
        await db.delete(accountQualifications).where(eq(accountQualifications.accountId, a.id)).catch(() => undefined);
      }
    }
    for (const userId of created) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function checkInvariants(
  db: Database,
  userIds: string[],
  organizationId: string,
  otherOrgId: string,
  fail: (code: string, detail: string) => void,
): Promise<void> {
  if (userIds.length === 0) return;
  const allAccounts = await db.select().from(accounts).where(inArray(accounts.userId, userIds));
  const accountById = new Map(allAccounts.map((a) => [a.id, a]));
  const allEnts = await db.select().from(entitlements).where(inArray(entitlements.userId, userIds));
  const acctIds = allAccounts.map((a) => a.id);
  const allQuals = acctIds.length
    ? await db.select().from(accountQualifications).where(inArray(accountQualifications.accountId, acctIds))
    : [];

  // I1: exactly one account per consumed entitlement, and no account is claimed
  // by two entitlements.
  const claimed = new Map<string, number>();
  for (const e of allEnts) {
    if (e.status === 'CONSUMED') {
      if (!e.consumedByAccountId || !accountById.has(e.consumedByAccountId)) {
        fail('I1', `consumed entitlement ${e.id} has no live account`);
        continue;
      }
      claimed.set(e.consumedByAccountId, (claimed.get(e.consumedByAccountId) ?? 0) + 1);
    }
  }
  for (const [accountId, n] of claimed) if (n > 1) fail('I1', `account ${accountId} consumed by ${n} entitlements`);

  // I2: one funded account per FUNDED qualification; no shared funded account.
  const fundedSeen = new Map<string, number>();
  for (const q of allQuals) {
    if (q.fundingState === 'FUNDED') {
      if (!q.fundedAccountId) {
        fail('I2', `FUNDED qualification ${q.id} has no funded account`);
        continue;
      }
      fundedSeen.set(q.fundedAccountId, (fundedSeen.get(q.fundedAccountId) ?? 0) + 1);
    }
  }
  for (const [accountId, n] of fundedSeen) if (n > 1) fail('I2', `funded account ${accountId} shared by ${n} qualifications`);

  // I5: at most one qualification per (account, lifecycle).
  const perLife = new Map<string, number>();
  for (const q of allQuals) {
    const key = `${q.accountId}:${q.lifecycleId}`;
    perLife.set(key, (perLife.get(key) ?? 0) + 1);
  }
  for (const [key, n] of perLife) if (n > 1) fail('I5', `${n} qualifications for ${key}`);

  for (const q of allQuals) {
    // I4: a qualification means the evaluation is frozen and stays frozen.
    if (q.fundingState !== 'DECLINED') {
      const evalAcct = accountById.get(q.accountId);
      if (evalAcct && (evalAcct.status !== 'PASSED' || evalAcct.adminHold !== 'QUALIFIED')) {
        fail('I4', `qualified evaluation ${q.accountId} is ${evalAcct.status}/${evalAcct.adminHold}, not PASSED/QUALIFIED`);
      }
    }
    // I3 + I6: the funded account is distinct, is FUNDED_SIM, and links back.
    if (q.fundedAccountId) {
      const funded = accountById.get(q.fundedAccountId);
      if (funded) {
        if (funded.id === q.accountId) fail('I3', `evaluation ${q.accountId} reused as its own funded account`);
        if (funded.accountType !== 'FUNDED_SIM') fail('I3', `funded account ${funded.id} is ${funded.accountType}`);
        if (funded.sourceQualificationId !== q.id || funded.sourceAccountId !== q.accountId) {
          fail('I6', `funded account ${funded.id} does not link back to qualification ${q.id}`);
        }
      }
    }
  }

  // I7: balances are finite integers.
  for (const a of allAccounts) {
    if (!Number.isFinite(a.balanceMicros) || !Number.isInteger(a.balanceMicros)) {
      fail('I7', `account ${a.id} has a non-integer balance ${a.balanceMicros}`);
    }
  }

  // I8: no qualification leaks across the organisation boundary.
  const leaked = allQuals.filter((q) => q.organizationId !== organizationId);
  if (leaked.length > 0) fail('I8', `${leaked.length} qualifications outside org ${organizationId}`);
  const crossVisible = acctIds.length
    ? await db
        .select()
        .from(accountQualifications)
        .where(and(inArray(accountQualifications.accountId, acctIds), eq(accountQualifications.organizationId, otherOrgId)))
    : [];
  if (crossVisible.length > 0) fail('I8', `${crossVisible.length} qualifications visible under the other org`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
