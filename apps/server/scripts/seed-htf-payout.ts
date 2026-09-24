/**
 * Seed one eligible HTF funded account for browser acceptance of the payout
 * engine. Idempotent-ish: re-running provisions another funded account for the
 * demo user. Synthetic; touches only the demo org.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/seed-htf-payout.ts
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { accounts, dailyAccountStats, users } from '../src/db/schema.js';
import { defaultOrganizationId, provisionAccount } from '../src/platform/provisioning.js';
import { publishProfileVersion } from '../src/platform/profiles.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
  const { db, sql } = createDb(url);
  try {
    const organizationId = await defaultOrganizationId(db);
    const [demo] = await db.select().from(users).where(eq(users.email, 'demo@atlasfutures.local'));
    if (!demo) throw new Error('demo user not found');

    await publishProfileVersion(db, {
      organizationId,
      key: 'htf-core-50k-funded',
      name: 'HTF Core 50K (Funded)',
      accountType: 'FUNDED_SIM',
      config: {
        rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
        execution: null,
        instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
        display: { startingBalanceMicros: $(50_000) },
        payoutRules: { model: 'CORE', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 5, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] } },
        fundedDestinationKey: null,
        whopPlanId: null,
      },
    }).catch(() => undefined); // already published on a re-run

    const { accountId } = await provisionAccount(db, { organizationId, userId: demo.id, profileKey: 'htf-core-50k-funded' });
    await db
      .update(accounts)
      .set({ name: 'HTF Funded 50K', balanceMicros: $(53_000), startingBalanceMicros: $(50_000), dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000), activatedAt: new Date('2026-02-01') })
      .where(eq(accounts.id, accountId));
    for (let i = 0; i < 5; i += 1) {
      await db.insert(dailyAccountStats).values({
        accountId,
        tradeDate: `2026-03-0${i + 1}`,
        startingBalanceMicros: $(50_000),
        endingBalanceMicros: $(50_200),
        highEquityMicros: $(50_200),
        lowEquityMicros: $(50_000),
        counted: true,
      }).catch(() => undefined);
    }
    // eslint-disable-next-line no-console
    console.log(`SEEDED funded account ${accountId} for demo@atlasfutures.local — eligible for a Core payout`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
