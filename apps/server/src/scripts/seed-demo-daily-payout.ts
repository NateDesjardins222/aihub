/**
 * Dev/browser-acceptance seed: a DAILY funded account whose next payout is blocked
 * ONLY by the Milestone 6 progressive qualifying-balance rule, so the portal can
 * show the Daily progression card and the DAILY_BALANCE_PROGRESSION_NOT_MET reason
 * end-to-end. Creates a dedicated throwaway user so it never disturbs the demo
 * trader's five active slots. Uses the real provisioning + profile domain (no
 * backdoor) and refuses to run in production.
 *
 *   npx tsx src/scripts/seed-demo-daily-payout.ts
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { accounts, dailyAccountStats, payoutRequests, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from '../platform/provisioning.js';
import { publishProfileVersion } from '../platform/profiles.js';
import { ensureCustomerIdentity } from '../platform/customer-identity.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

export const DAILY_DEMO_EMAIL = 'daily-demo@atlasfutures.local';
export const DAILY_DEMO_PASSWORD = 'atlas-demo-2026';

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('refusing to seed a daily fixture in production');
  const { db } = getDb();
  const organizationId = await defaultOrganizationId(db);

  let [u] = await db.select().from(users).where(eq(users.email, DAILY_DEMO_EMAIL));
  if (!u) {
    [u] = await db
      .insert(users)
      .values({ email: DAILY_DEMO_EMAIL, passwordHash: await hashPassword(DAILY_DEMO_PASSWORD), displayName: 'Dana Daily', organizationId })
      .returning();
  }
  const user = u!;
  await ensureCustomerIdentity(db, { organizationId, userId: user.id });

  // A DAILY funded product where the ONLY thing standing between this account and
  // an eligible payout is the progressive qualifying-balance rule.
  await publishProfileVersion(db, {
    organizationId,
    key: 'htf-daily-50k-funded',
    name: 'HTF Daily 50K (Funded)',
    accountType: 'FUNDED_SIM',
    config: {
      rules: { accountSizeMicros: $(50_000), profitTargetMicros: 0, maxLossMicros: $(2000), drawdownType: 'STATIC', trailingLockAtMicros: null, dailyLossLimitMicros: null, dailyLossPolicy: 'LOCK_DAY', consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null, minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50, microsCountAsFraction: false, flattenOnBreach: true },
      execution: null,
      instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
      display: { startingBalanceMicros: $(50_000) },
      payoutRules: { model: 'DAILY', profitSplitPercent: 0.9, activationFeeMicros: 0, winningDayThresholdMicros: $(150), requiredWinningDays: 3, payoutConsistencyThreshold: null, fundedBufferMicros: 0, requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000), $(2000)] } },
      fundedDestinationKey: null,
      whopPlanId: null,
    },
  }).catch(() => undefined); // already published on a re-run

  const { accountId } = await provisionAccount(db, { organizationId, userId: user.id, profileKey: 'htf-daily-50k-funded' });

  // Balance sits BELOW the previous approved payout's qualifying balance, so the
  // sole remaining blocker is the progressive-balance rule.
  const previousQualifying = $(55_000);
  const currentBalance = $(54_000);
  await db
    .update(accounts)
    .set({
      name: 'HTF Daily 50K', balanceMicros: currentBalance, startingBalanceMicros: $(50_000),
      dayStartBalanceMicros: currentBalance, dayStartEquityMicros: currentBalance, highWaterMarkMicros: $(56_000),
      activatedAt: new Date('2026-02-01'),
    })
    .where(eq(accounts.id, accountId));

  // Enough counted winning days that only the progression rule blocks.
  for (let i = 0; i < 5; i += 1) {
    await db.insert(dailyAccountStats).values({
      accountId, tradeDate: `2026-03-0${i + 1}`,
      startingBalanceMicros: $(50_000), endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true,
    }).catch(() => undefined);
  }

  // A prior PAID payout that fixes the previous qualifying balance. previousDailyQualifyingBalance()
  // reads the max qualifyingBalanceAtApproval over APPROVED/PROCESSING/PAID payouts.
  const existing = await db.select({ id: payoutRequests.id }).from(payoutRequests).where(eq(payoutRequests.accountId, accountId));
  if (existing.length === 0) {
    await db.insert(payoutRequests).values({
      organizationId, accountId, userId: user.id, state: 'PAID',
      requestedGrossMicros: $(2000), feesMicros: 0, traderShareMicros: $(1800), firmShareMicros: $(200),
      payoutOrdinal: 1, version: 1, qualifyingBalanceAtApproval: previousQualifying,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`SEEDED daily funded account ${accountId} for ${DAILY_DEMO_EMAIL} — blocked only by DAILY_BALANCE_PROGRESSION_NOT_MET (prev $55k, balance $54k)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
