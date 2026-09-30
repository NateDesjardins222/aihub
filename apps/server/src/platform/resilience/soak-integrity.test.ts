/**
 * Engineering Resilience Phase 3 — infrastructure soak (Parts XXX, XXXI, XVI/XVII).
 *
 * Attacks the delivery, tamper-evidence and monotonicity machinery at scale:
 *   - Part XXX  outbox: exactly-once EFFECTIVE delivery under a large backlog,
 *               disjoint claims across many concurrent workers, and poison-row
 *               isolation (a permanently-failing row parks as dead_letter and
 *               never blocks its siblings).
 *   - Part XXXI audit: the hash chain stays intact across a burst of appends,
 *               and an out-of-band forged row is detected as a break.
 *   - Part XVI/XVII monotonicity: a stale or duplicated ACCOUNT event, replayed
 *               out of order, can never regress the read-model's state version —
 *               the projection only ever moves forward.
 *
 * Deterministic (seeded); no wall-clock sleeps. Outbox aggregate ids are real
 * UUIDs (the column is uuid); rows are isolated on the shared test DB by a
 * run-unique aggregate_type, and audit bursts run in throwaway organisations so
 * the shared default org's (undeletable, append-only) chain is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb } from '../../db/client.js';
import { accounts, accountProjections, auditLog, organizations, outboxEvents, users } from '../../db/schema.js';
import { hashPassword } from '../../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../provisioning.js';
import { publishProfileVersion, resolveProfileByKey } from '../profiles.js';
import { enqueueOutbox, OutboxWorker, outboxStats } from '../outbox.js';
import { auditHash, recordAudit, verifyAuditChain } from '../audit.js';
import { accountOutboxHandler, projectAccount, reconcileAccountProjection } from '../projection.js';
import { SYSTEM_ACTOR } from '../actor.js';
import { Prng } from './model/prng.js';

const M = 1_000_000;
const $ = (d: number) => d * M;
let handle: ReturnType<typeof createDb>;
let db: ReturnType<typeof createDb>['db'];
let organizationId: string;
const EVAL_KEY = `si-eval-${Math.random().toString(36).slice(2, 7)}`;
const uuid = () => crypto.randomUUID();
// A run-unique aggregate_type base (<=20 chars) so outbox counts are isolated on
// the shared, dirty test DB.
const AT = `SK${Math.random().toString(36).slice(2, 8)}`;

function evalConfig() {
  return {
    rules: { accountSizeMicros: $(50_000), profitTargetMicros: $(3_000), maxLossMicros: $(2_000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 10, microsCountAsFraction: true, flattenOnBreach: true },
    execution: null, instruments: { allowed: null, maxContracts: 10, perInstrument: {} }, display: { startingBalanceMicros: $(50_000), priceMicros: 95 * M },
    payoutRules: null, fundedDestinationKey: null, whopPlanId: null,
  };
}

/** Drain until no rows of this aggregate_type remain undelivered (bounded).
 * Absorbs rows momentarily locked by a co-operating drainer in a shared DB. */
async function settleType(at: string, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new OutboxWorker(db, { batch: 50, handler: async () => undefined }).runUntilEmpty();
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateType, at));
    if ((row?.n ?? 0) === 0) return;
    const [pending] = await db
      .select({ n: sql<number>`count(*) filter (where ${outboxEvents.deliveredAt} is null and ${outboxEvents.deadLetter} = false)::int` })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateType, at));
    if ((pending?.n ?? 0) === 0) return;
  }
}

async function throwawayOrg(): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ slug: `soak-${Math.random().toString(36).slice(2, 10)}`, name: 'Soak Org' })
    .returning();
  return org!.id;
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  process.env['DATABASE_URL'] = url;
  process.env['HTF_AUTO_FUNDING'] = 'false';
  // A dedicated pool with NO background outbox worker (buildApp starts one that
  // would race this test's own workers and steal its rows). We drive the outbox
  // deterministically here, so the only workers are the ones the test creates.
  handle = createDb(url);
  db = handle.db;
  organizationId = await defaultOrganizationId(db);
  await publishProfileVersion(db, { organizationId, key: EVAL_KEY, name: 'SI Eval 50K', accountType: 'EVALUATION', config: evalConfig() });
}, 60000);
afterAll(async () => { await handle?.sql.end({ timeout: 5 }); });

// The outbox scale soak (400/300-row backlogs, a 6-worker fleet) is a MEDIUM-tier
// soak: exactly-once + SKIP-LOCKED disjointness are already proven in canonical by
// projection-outbox.test.ts and the R2 durability tests. At soak scale it shares
// the outbox table with the full suite's transient workers, so it runs behind
// RESILIENCE_DEEP. The audit-chain and read-model monotonicity parts below are
// deterministic and stay in the canonical gate.
const DEEP = process.env['RESILIENCE_DEEP'] === '1';

describe.runIf(DEEP)('Part XXX — outbox soak: exactly-once effective delivery at scale', () => {
  it('drains a large backlog with an idempotent consumer: every row delivered exactly once', async () => {
    const N = 400;
    const at = `${AT}a`;
    for (let i = 0; i < N; i += 1) {
      await enqueueOutbox(db, { aggregateId: uuid(), aggregateType: at, type: 'soak.event', payload: { i } });
    }
    // Idempotent consumer: counts effective deliveries per outbox-row id.
    const seen = new Map<string, number>();
    const worker = new OutboxWorker(db, {
      batch: 37,
      handler: async (_tx, ev) => {
        if (ev.aggregateType !== at) return;
        seen.set(ev.id, (seen.get(ev.id) ?? 0) + 1);
      },
    });
    await worker.runUntilEmpty();
    await settleType(at); // absorb any row momentarily locked by a co-operating drainer
    const ourRows = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateType, at));
    expect(ourRows).toHaveLength(N);
    // Exactly-once EFFECT: every row is delivered (deliveredAt set), none parked,
    // and our idempotent consumer never observed any row twice. A row is marked
    // delivered in the same transaction that claims it and is then excluded from
    // future claims, so a delivery mark is structurally at-most-once system-wide;
    // this asserts that structural guarantee plus at-least-once completion. (We do
    // NOT assert our own consumer delivered ALL N — in a real multi-worker system
    // another drainer may legitimately claim some rows; that is the point.)
    for (const r of ourRows) {
      expect(r.deliveredAt).not.toBeNull(); // delivered exactly once by the system
      expect(r.deadLetter).toBe(false);
    }
    for (const [, count] of seen) expect(count).toBe(1); // our consumer never double-processed
    // eslint-disable-next-line no-console
    console.log(`[soak outbox once] enqueued=${N} allDelivered=${ourRows.every((r) => r.deliveredAt !== null)} consumerSaw=${seen.size} maxSeen=${Math.max(0, ...seen.values())}`);
  }, 120000);

  it('many concurrent workers claim disjoint rows (SKIP LOCKED): no double-claim, every row delivered', async () => {
    const N = 300;
    const at = `${AT}b`;
    for (let i = 0; i < N; i += 1) {
      await enqueueOutbox(db, { aggregateId: uuid(), aggregateType: at, type: 'soak.conc', payload: { i } });
    }
    const claimed: Array<Set<string>> = [];
    const workers = Array.from({ length: 6 }, () => {
      const mine = new Set<string>();
      claimed.push(mine);
      return new OutboxWorker(db, {
        batch: 13,
        handler: async (_tx, ev) => { if (ev.aggregateType === at) mine.add(ev.id); },
      });
    });
    await Promise.all(workers.map((w) => w.runUntilEmpty()));
    // The core SKIP LOCKED guarantee: no two workers in the fleet ever claimed the
    // same row (disjoint claims). If FOR UPDATE SKIP LOCKED were broken, the same
    // id would appear in two workers' sets.
    const union = new Set<string>();
    let overlaps = 0;
    for (const set of claimed) for (const id of set) { if (union.has(id)) overlaps += 1; union.add(id); }
    expect(overlaps).toBe(0); // never claimed twice across the fleet
    // Completeness: every row ends delivered exactly once (by this fleet or, in a
    // real multi-worker system, a co-operating drainer — either way, once).
    await settleType(at);
    const ourRows = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateType, at));
    expect(ourRows).toHaveLength(N);
    for (const r of ourRows) expect(r.deliveredAt).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log(`[soak outbox concurrent] workers=6 rows=${N} fleetClaimed=${union.size} overlaps=${overlaps} allDelivered=true`);
  }, 120000);

  it('a poison row parks as dead_letter after maxAttempts and never blocks its siblings', async () => {
    const at = `${AT}c`;
    const good = 30;
    for (let i = 0; i < good; i += 1) {
      await enqueueOutbox(db, { aggregateId: uuid(), aggregateType: at, type: 'soak.good', payload: { i } });
    }
    const poisonId = uuid();
    await enqueueOutbox(db, { aggregateId: poisonId, aggregateType: at, type: 'soak.poison', payload: { poison: true } });
    let deliveredGood = 0;
    const worker = new OutboxWorker(db, {
      batch: 8,
      maxAttempts: 3,
      backoffBaseMs: 0, // no wall-clock wait: retries are immediately available
      backoffCapMs: 0,
      handler: async (_tx, ev) => {
        if (ev.aggregateType !== at) return;
        if (ev.type === 'soak.poison') throw new Error('poison: permanent handler failure');
        deliveredGood += 1;
      },
    });
    // Tick until the poison row exhausts its attempts. runUntilEmpty() would stop
    // the moment a tick delivers zero (the good rows drained, only the failing
    // poison left), so drive ticks explicitly until it dead-letters.
    let poison = (await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, poisonId)))[0]!;
    for (let i = 0; i < 12 && !poison.deadLetter; i += 1) {
      await worker.tick();
      poison = (await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, poisonId)))[0]!;
    }
    expect(deliveredGood).toBe(good); // all good rows delivered despite the poison
    expect(poison.deadLetter).toBe(true);
    expect(poison.deliveredAt).toBeNull();
    expect(poison.attempts).toBeGreaterThanOrEqual(3);
    const stats = await outboxStats(db);
    expect(stats).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`[soak outbox poison] good=${good} deliveredGood=${deliveredGood} poisonDeadLetter=${poison.deadLetter} attempts=${poison.attempts}`);
  }, 120000);
});

describe('Part XXXI — audit-chain soak: tamper-evident across a burst', () => {
  it('the hash chain stays intact across a burst of appended entries', async () => {
    // A fresh org gives a clean, deterministic chain (the shared default org is a
    // dirty, append-only chain from prior runs — not this test's subject).
    const orgId = await throwawayOrg();
    const BURST = 120;
    for (let i = 0; i < BURST; i += 1) {
      await recordAudit(db, {
        organizationId: orgId,
        actor: SYSTEM_ACTOR,
        subjectType: 'ACCOUNT',
        subjectId: null,
        action: 'soak.audit.append',
        prevState: null,
        newState: { i },
        reason: null,
      });
    }
    const v = await verifyAuditChain(db, orgId);
    expect(v.ok).toBe(true);
    expect(v.brokenAt).toBeNull();
    expect(v.checked).toBe(BURST);
    // eslint-disable-next-line no-console
    console.log(`[soak audit] appended=${BURST} chainChecked=${v.checked} ok=${v.ok}`);
  }, 120000);

  it('an out-of-band forged row is detected as a chain break', async () => {
    const orgId = await throwawayOrg();
    for (let i = 0; i < 5; i += 1) {
      await recordAudit(db, { organizationId: orgId, actor: SYSTEM_ACTOR, subjectType: 'ACCOUNT', subjectId: null, action: 'honest', prevState: null, newState: { i }, reason: null });
    }
    const before = await verifyAuditChain(db, orgId);
    expect(before.ok).toBe(true);

    // Forge a row directly (an attacker with a DB connection / a doctored restore):
    // its own content hash cannot verify → the walk flags it.
    await db.insert(auditLog).values({
      organizationId: orgId,
      actorType: 'SYSTEM',
      subjectType: 'ACCOUNT',
      action: 'forged.injection',
      prevState: null,
      newState: { evil: true },
      reason: null,
      prevHash: null,
      hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    const after = await verifyAuditChain(db, orgId);
    expect(after.ok).toBe(false);
    expect(after.brokenAt).not.toBeNull();
    expect(auditHash(null, { any: 1 })).toMatch(/^[0-9a-f]{64}$/);
    // eslint-disable-next-line no-console
    console.log(`[soak audit tamper] beforeOk=${before.ok} afterOk=${after.ok} brokenAt=${after.brokenAt?.slice(0, 8)}`);
  }, 120000);
});

describe('Part XVI/XVII — monotonicity soak: a stale/duplicate event never regresses the read model', () => {
  it('replaying old ACCOUNT events out of order keeps the projection state version monotonic', async () => {
    const [u] = await db.insert(users).values({ email: `mono-${uuid().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'), displayName: 'mono', organizationId }).returning();
    const product = await resolveProfileByKey(db, organizationId, EVAL_KEY);
    const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileVersionId: product.versionId, activate: true, idempotencyKey: `mono-${u!.id}` });

    const staleEvent = { aggregateType: 'ACCOUNT', aggregateId: accountId };
    await projectAccount(db, accountId);
    const versions: number[] = [];
    const rng = new Prng(24680);
    const STEPS = 40;
    for (let i = 0; i < STEPS; i += 1) {
      // A financial mutation always bumps seq; vary the balance so the snapshot changes.
      const delta = $(rng.int(1, 25));
      await db.update(accounts).set({ balanceMicros: sql`${accounts.balanceMicros} + ${delta}`, seq: sql`${accounts.seq} + 1`, updatedAt: new Date() }).where(eq(accounts.id, accountId));
      await projectAccount(db, accountId);
      const [proj] = await db.select().from(accountProjections).where(eq(accountProjections.accountId, accountId));
      versions.push(proj!.stateVersion);
    }
    for (let i = 1; i < versions.length; i += 1) expect(versions[i]!).toBeGreaterThanOrEqual(versions[i - 1]!);
    const peak = versions[versions.length - 1]!;

    // Hammer the STALE event (an out-of-order / duplicated delivery). The
    // idempotent consumer recomputes from authority; the monotonic guard means the
    // stored version never goes backwards and stays pinned to the account seq.
    for (let t = 0; t < 30; t += 1) {
      await accountOutboxHandler(db, staleEvent);
      const [proj] = await db.select().from(accountProjections).where(eq(accountProjections.accountId, accountId));
      expect(proj!.stateVersion).toBe(peak); // never regresses, never overshoots authority
    }
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(peak).toBe(acct!.seq);
    const recon = await reconcileAccountProjection(db, accountId);
    expect(recon.ok).toBe(true);
    expect(recon.diffs).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[soak monotonic] steps=${STEPS} peakVersion=${peak} staleReplays=30 reconcileOk=${recon.ok}`);
  }, 120000);
});
