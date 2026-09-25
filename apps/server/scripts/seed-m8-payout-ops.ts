/**
 * Seed the demo org for Milestone 8 (Fast Payout Operations) browser acceptance.
 *
 * It is synthetic and touches only the demo org. It:
 *   - enables the MOCK payout provider for the org (never a real provider);
 *   - gives the demo user a customer identity + a live MOCK destination so the
 *     trader Payout Methods page and the terminal fast lane have something real;
 *   - provisions one eligible HTF funded account for the demo user (unrequested,
 *     so the terminal "request a payout" scenario still has work to do);
 *   - seeds a spread of operations across states on synthetic accounts so the
 *     owner Payout Operations console has content in every queue: PAID (fast
 *     lane, settled via an authoritative webhook), PROCESSING, a DESTINATION_REVIEW
 *     exception, and a PROVIDER_REJECTED exception.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/seed-m8-payout-ops.ts
 */
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../src/db/client.js';
import { accounts, dailyAccountStats, users } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../src/platform/provisioning.js';
import { publishProfileVersion } from '../src/platform/profiles.js';
import { SYSTEM_ACTOR } from '../src/platform/actor.js';
import { ensureCustomerIdentity } from '../src/platform/customer-identity.js';
import { requestPayout } from '../src/platform/payouts.js';
import { addDestination } from '../src/platform/payout-destinations.js';
import { updateOpsConfig, getOpsConfig } from '../src/platform/payout-ops-config.js';
import { mockPayoutProvider, resetMockPayoutProvider } from '../src/platform/payout-provider-registry.js';
import { getOperationByRequest, ingestProviderEvent, runFastLane, submitPayable } from '../src/platform/payout-operations.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

const CFG = {
  rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const, consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
  execution: null,
  instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
  display: { startingBalanceMicros: $(50_000) },
  payoutRules: { model: 'CORE' as const, profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000), $(2000), $(2000), $(2000)] } },
  fundedDestinationKey: null,
  whopPlanId: null,
};

async function eligibleAccount(db: Database, organizationId: string, tag: string, withDest: boolean): Promise<{ accountId: string; userId: string; identityId: string }> {
  const [u] = await db.insert(users).values({ email: `m8seed-${tag}-${Date.now()}@demo.local`, passwordHash: await hashPassword('x'), displayName: `M8 ${tag}`, organizationId }).returning();
  const ident = await ensureCustomerIdentity(db, { organizationId, userId: u!.id });
  const { accountId } = await provisionAccount(db, { organizationId, userId: u!.id, profileKey: 'htf-core-50k-funded' });
  await db.update(accounts).set({ name: `HTF ${tag}`, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, accountId));
  for (let i = 0; i < 5; i += 1) {
    await db.insert(dailyAccountStats).values({ accountId, tradeDate: `2026-03-0${i + 1}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true });
  }
  if (withDest) await addDestination(db, { organizationId, customerIdentityId: ident.id, provider: 'MOCK', providerRef: `mock_dest_${tag}_${Date.now()}` });
  return { accountId, userId: u!.id, identityId: ident.id };
}

async function req(db: Database, a: { accountId: string; userId: string }, gross = $(1000)): Promise<string> {
  const r = await requestPayout(db, { accountId: a.accountId, userId: a.userId, requestedGrossMicros: gross, idempotencyKey: `m8seed-${a.accountId}-${Date.now()}`, actor: SYSTEM_ACTOR });
  return r.id;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
  const { db, sql } = createDb(url);
  resetMockPayoutProvider();
  try {
    const organizationId = await defaultOrganizationId(db);
    const [demo] = await db.select().from(users).where(eq(users.email, 'demo@atlasfutures.local'));
    if (!demo) throw new Error('demo user not found — run the base seed first');

    await publishProfileVersion(db, { organizationId, key: 'htf-core-50k-funded', name: 'HTF Core 50K (Funded)', accountType: 'FUNDED_SIM', config: CFG }).catch(() => undefined);

    // 1) Enable the MOCK provider for the org (never a real provider in a seed).
    await updateOpsConfig(db, organizationId, { provider: 'MOCK', actor: SYSTEM_ACTOR });

    // 2) The demo user: identity + a live MOCK destination + an eligible account.
    const demoIdent = await ensureCustomerIdentity(db, { organizationId, userId: demo.id });
    await addDestination(db, { organizationId, customerIdentityId: demoIdent.id, provider: 'MOCK', providerRef: `mock_dest_demo_${Date.now()}` }).catch(() => undefined);
    const { accountId: demoAccountId } = await provisionAccount(db, { organizationId, userId: demo.id, profileKey: 'htf-core-50k-funded' });
    await db.update(accounts).set({ name: 'HTF Funded 50K', balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, demoAccountId));
    for (let i = 0; i < 5; i += 1) {
      await db.insert(dailyAccountStats).values({ accountId: demoAccountId, tradeDate: `2026-03-0${i + 1}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true }).catch(() => undefined);
    }

    // A second demo-owned account with a settled payout, so the trader Payout
    // Methods page shows a real recent payout with a customer-safe timeline.
    const { accountId: demoPaidAccount } = await provisionAccount(db, { organizationId, userId: demo.id, profileKey: 'htf-core-50k-funded' });
    await db.update(accounts).set({ name: 'HTF Payout History 50K', balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01T00:00:00Z') }).where(eq(accounts.id, demoPaidAccount));
    for (let i = 0; i < 5; i += 1) {
      await db.insert(dailyAccountStats).values({ accountId: demoPaidAccount, tradeDate: `2026-03-1${i}`, startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true }).catch(() => undefined);
    }
    const demoPaidId = await req(db, { accountId: demoPaidAccount, userId: demo.id });
    await runFastLane(db, demoPaidId);
    await submitPayable(db, demoPaidId);
    {
      const op = await getOperationByRequest(db, demoPaidId);
      const hook = mockPayoutProvider().advance(op!.idempotencyKey, 'PAID');
      if (hook) await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_PAID', amountMicros: $(900) });
    }

    // 3) A spread of operations for the owner console.
    // PAID — fast lane → submit → authoritative PAID webhook.
    const paidAcct = await eligibleAccount(db, organizationId, 'PAID', true);
    const paidId = await req(db, paidAcct);
    await runFastLane(db, paidId);
    await submitPayable(db, paidId);
    {
      const op = await getOperationByRequest(db, paidId);
      const hook = mockPayoutProvider().advance(op!.idempotencyKey, 'PAID');
      if (hook) await ingestProviderEvent(db, { organizationId, provider: 'MOCK', providerEventId: hook.providerEventId, providerPayoutId: hook.providerPayoutId, normalizedType: 'PAYOUT_PAID', amountMicros: $(900) });
    }

    // PROCESSING — fast lane → submit, no settlement yet.
    const procAcct = await eligibleAccount(db, organizationId, 'PROCESSING', true);
    const procId = await req(db, procAcct);
    await runFastLane(db, procId);
    await submitPayable(db, procId);

    // DESTINATION_REVIEW exception — eligible but no destination on file.
    const noDestAcct = await eligibleAccount(db, organizationId, 'NODEST', false);
    const noDestId = await req(db, noDestAcct);
    await runFastLane(db, noDestId).catch(() => undefined);

    // PROVIDER_REJECTED exception — the provider hard-rejects at submission.
    const rejAcct = await eligibleAccount(db, organizationId, 'REJECT', true);
    const rejId = await req(db, rejAcct);
    await runFastLane(db, rejId);
    {
      const op = await getOperationByRequest(db, rejId);
      mockPayoutProvider().program(op!.idempotencyKey, { onSubmit: 'HARD_REJECT' });
      await submitPayable(db, rejId).catch(() => undefined);
    }

    const config = await getOpsConfig(db, organizationId);
    console.log('M8 seed complete:');
    console.log(`  org=${organizationId} provider=${config.provider} productionEnabled=${config.productionEnabled}`);
    console.log(`  demo account=${demoAccountId} (HTF Funded 50K, eligible, MOCK destination on file)`);
    console.log(`  seeded ops: PAID=${paidId} PROCESSING=${procId} NODEST=${noDestId} REJECT=${rejId}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
