/**
 * Product Recovery Phase 3 — payout EXACT boundaries and the accounting
 * invariant, through the REAL payout service + Postgres ledger (STEP 4/5).
 *
 * Phase 2 proved a full single payout cycle at L4 but left the fine numeric
 * boundaries proven only in pure unit tests (L1). This closes that gap: every
 * boundary below is asserted against the production service (getPayoutEligibility
 * / requestPayout / approvePayout, real transactions, advisory locks, the
 * append-only ledger) with the canonical product numbers imported from
 * @atlas/contracts — so the test asserts the SHIPPING catalog, not invented ones.
 *
 * Boundaries proven (L3/L4):
 *   • Winning-day threshold is inclusive at exactly $150.00: $149.99 does NOT
 *     qualify, $150.00 and $150.01 do.
 *   • 4 winning days is ineligible; the 5th makes it eligible.
 *   • The request ceiling composes min(withdrawable, product cap, 50% of
 *     withdrawable): the exact-50% edge approves at the cap and rejects one
 *     micro above.
 *   • Per-size request caps: 25K=$1,000 / 50K=$2,000 / 100K=$3,500 / 300K=$5,000.
 *   • Daily loss buffers: 25K=$1,000 / 50K=$2,000 / 100K=$4,000, protected from
 *     the withdrawable.
 *   • The 90/10 split and the money invariant: pre − debit = post, and
 *     trader + firm = gross, to the micro, with the rounding remainder absorbed by
 *     the firm (never lost, never created). All money is integer micros.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  MIN_PAYOUT_REQUEST_USD, REQUIRED_WINNING_DAYS, WINNING_DAY_THRESHOLD_USD,
  bufferUsdOf, payoutCapUsd, FAMILIES,
} from '@atlas/contracts';
import { buildApp } from '../http/app.js';
import { getDb, type Database } from '../db/client.js';
import { accounts, dailyAccountStats, payoutLedger, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { defaultOrganizationId, provisionAccount } from './provisioning.js';
import { publishProfileVersion } from './profiles.js';
import { SYSTEM_ACTOR } from './actor.js';
import {
  approvePayout, getPayoutEligibility, requestPayout, PayoutError,
} from './payouts.js';

const M = 1_000_000;
const $ = (d: number) => Math.round(d * M);
let app: FastifyInstance;
let db: Database;
let organizationId: string;
let seq = 0;

/** The Daily loss buffer the shipping catalog assigns a size (whole dollars). */
function dailyBufferUsd(sizeUsd: number): number {
  const daily = FAMILIES.find((f) => f.key === 'DAILY')!;
  const acct = daily.accounts.find((a) => a.sizeUsd === sizeUsd)!;
  return bufferUsdOf(acct);
}

function fundedConfig(model: 'CORE' | 'SELECT' | 'DAILY', sizeUsd: number) {
  const sizeMicros = $(sizeUsd);
  return {
    rules: {
      accountSizeMicros: sizeMicros, profitTargetMicros: 0, maxLossMicros: $(2000),
      drawdownType: 'STATIC' as const, trailingLockAtMicros: null, dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY' as const, consistencyFormula: 'BEST_DAY_OVER_TOTAL' as const,
      consistencyThreshold: null, minTradingDays: 0, minWinningDays: 0, maxTradingDays: null,
      minDailyPnlToCountMicros: 0, minWinningDayPnlMicros: 1, maxContracts: 50,
      microsCountAsFraction: false, flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: 50, perInstrument: {} },
    display: { startingBalanceMicros: sizeMicros },
    payoutRules: {
      model,
      profitSplitPercent: 0.9,
      activationFeeMicros: 0,
      winningDayThresholdMicros: $(WINNING_DAY_THRESHOLD_USD), // canonical $150
      requiredWinningDays: REQUIRED_WINNING_DAYS,             // canonical 5
      payoutConsistencyThreshold: model === 'SELECT' ? 0.4 : null,
      fundedBufferMicros: model === 'DAILY' ? $(dailyBufferUsd(sizeUsd)) : 0,
      requestCaps: {
        minRequestMicros: $(MIN_PAYOUT_REQUEST_USD),         // canonical $250
        maxRequestMicrosByOrdinal: [$(payoutCapUsd(sizeUsd))], // canonical per-size cap
      },
    },
    fundedDestinationKey: null,
    whopPlanId: null,
  };
}

async function makeUser(): Promise<string> {
  seq += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `pb-${seq}-${Date.now()}@test.local`, passwordHash: await hashPassword('x'), displayName: 'Payout Boundary', organizationId })
    .returning();
  return u!.id;
}

/** A funded account at `starting + profit`, with `winDays` days each netting `dayNet`. */
async function makeFunded(
  key: string,
  opts: { sizeUsd: number; profit: number; winDays?: number; dayNet?: number },
): Promise<string> {
  const userId = await makeUser();
  const { accountId } = await provisionAccount(db, { organizationId, userId, profileKey: key });
  const starting = $(opts.sizeUsd);
  const balance = starting + opts.profit;
  await db.update(accounts).set({
    balanceMicros: balance, startingBalanceMicros: starting,
    dayStartBalanceMicros: balance, dayStartEquityMicros: balance,
    highWaterMarkMicros: Math.max(balance, starting),
    activatedAt: new Date('2026-02-01T00:00:00Z'),
  }).where(eq(accounts.id, accountId));

  const days = opts.winDays ?? 0;
  const net = opts.dayNet ?? $(200);
  for (let i = 0; i < days; i += 1) {
    const date = `2026-03-${String(i + 1).padStart(2, '0')}`;
    await db.insert(dailyAccountStats).values({
      accountId, tradeDate: date, startingBalanceMicros: starting,
      endingBalanceMicros: starting + net, highEquityMicros: starting + net,
      lowEquityMicros: starting, counted: true,
    });
  }
  return accountId;
}

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  db = getDb().db;
  organizationId = await defaultOrganizationId(db);
  // Publish funded versions carrying the canonical caps/buffers per size.
  for (const size of [25_000, 50_000, 100_000, 300_000]) {
    await publishProfileVersion(db, { organizationId, key: `pb-core-${size}`, name: `PB Core ${size}`, accountType: 'FUNDED_SIM', config: fundedConfig('CORE', size) });
  }
  for (const size of [25_000, 50_000, 100_000]) {
    await publishProfileVersion(db, { organizationId, key: `pb-daily-${size}`, name: `PB Daily ${size}`, accountType: 'FUNDED_SIM', config: fundedConfig('DAILY', size) });
  }
});
afterAll(async () => { await app.close(); });

describe('winning-day threshold is inclusive at exactly $150.00', () => {
  it('$149.99 days never qualify (5 of them → still ineligible)', async () => {
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 5, dayNet: $(149.99) });
    const { eligibility } = await getPayoutEligibility(db, acct);
    expect(eligibility.qualifyingWinningDays).toBe(0);
    expect(eligibility.state).toBe('NOT_ELIGIBLE');
    expect(eligibility.reasonCodes).toContain('INSUFFICIENT_WINNING_DAYS');
  });
  it('$150.00 days qualify (exactly the threshold)', async () => {
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 5, dayNet: $(150.00) });
    const { eligibility } = await getPayoutEligibility(db, acct);
    expect(eligibility.qualifyingWinningDays).toBe(5);
    expect(eligibility.state).toBe('ELIGIBLE');
  });
  it('$150.01 days qualify (just above the threshold)', async () => {
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 5, dayNet: $(150.01) });
    const { eligibility } = await getPayoutEligibility(db, acct);
    expect(eligibility.qualifyingWinningDays).toBe(5);
    expect(eligibility.state).toBe('ELIGIBLE');
  });
});

describe('winning-days count boundary: 4 not eligible, 5 eligible', () => {
  it('4 winning days is one short', async () => {
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 4 });
    const { eligibility } = await getPayoutEligibility(db, acct);
    expect(eligibility.qualifyingWinningDays).toBe(4);
    expect(eligibility.state).toBe('NOT_ELIGIBLE');
    expect(eligibility.reasonCodes).toContain('INSUFFICIENT_WINNING_DAYS');
  });
  it('the 5th winning day makes it eligible', async () => {
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 5 });
    const { eligibility } = await getPayoutEligibility(db, acct);
    expect(eligibility.qualifyingWinningDays).toBe(5);
    expect(eligibility.state).toBe('ELIGIBLE');
  });
});

describe('request ceiling composes the exact 50%-of-withdrawable constraint', () => {
  it('approves at exactly 50% and rejects one micro above', async () => {
    // 50K Core, withdrawable $3,000 → cap $2,000, 50% = $1,500. The 50% term binds.
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 5 });
    const { eligibility, account } = await getPayoutEligibility(db, acct);
    expect(eligibility.grossWithdrawableMicros).toBe($(3000));
    expect(eligibility.maxRequestMicros).toBe($(1500)); // floor(0.5 × 3,000)

    // One micro above the ceiling is refused with the exact reason, no money moved.
    await expect(
      requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: $(1500) + 1, actor: SYSTEM_ACTOR }),
    ).rejects.toMatchObject({ reason: 'ABOVE_MAXIMUM' });

    // Exactly at the ceiling is accepted and approves.
    const req = await requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: $(1500), idempotencyKey: `fifty-${acct}`, actor: SYSTEM_ACTOR });
    const approved = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(approved.state).toBe('APPROVED');
  });

  it('below the minimum ($250) is refused', async () => {
    const acct = await makeFunded('pb-core-50000', { sizeUsd: 50_000, profit: $(3000), winDays: 5 });
    const { account } = await getPayoutEligibility(db, acct);
    await expect(
      requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: $(250) - 1, actor: SYSTEM_ACTOR }),
    ).rejects.toMatchObject({ reason: 'BELOW_MINIMUM' });
  });
});

describe('per-size request caps are exactly the shipping catalog values', () => {
  const cases = [
    { size: 25_000, cap: 1_000 },
    { size: 50_000, cap: 2_000 },
    { size: 100_000, cap: 3_500 },
    { size: 300_000, cap: 5_000 },
  ];
  for (const c of cases) {
    it(`${c.size / 1000}K caps a payout request at $${c.cap}`, async () => {
      // Withdrawable set so 50% strictly exceeds the cap → the CAP binds.
      const profit = $(c.cap * 2 + 1000);
      const acct = await makeFunded(`pb-core-${c.size}`, { sizeUsd: c.size, profit, winDays: 5 });
      const { eligibility, account } = await getPayoutEligibility(db, acct);
      expect(payoutCapUsd(c.size)).toBe(c.cap); // matches the canonical catalog
      expect(eligibility.maxRequestMicros).toBe($(c.cap));
      // At the cap it approves; one micro over is refused.
      await expect(
        requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: $(c.cap) + 1, actor: SYSTEM_ACTOR }),
      ).rejects.toMatchObject({ reason: 'ABOVE_MAXIMUM' });
      const req = await requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: $(c.cap), idempotencyKey: `cap-${acct}`, actor: SYSTEM_ACTOR });
      expect(req.state).toBe('REQUESTED');
    });
  }
});

describe('Daily loss buffers are protected from the withdrawable', () => {
  const cases = [
    { size: 25_000, buffer: 1_000 },
    { size: 50_000, buffer: 2_000 },
    { size: 100_000, buffer: 4_000 },
  ];
  for (const c of cases) {
    it(`${c.size / 1000}K Daily protects a $${c.buffer} buffer`, async () => {
      expect(dailyBufferUsd(c.size)).toBe(c.buffer); // canonical
      // Profit = buffer + $2,000 withdrawable headroom.
      const profit = $(c.buffer + 2_000);
      const acct = await makeFunded(`pb-daily-${c.size}`, { sizeUsd: c.size, profit, winDays: 5 });
      const { eligibility } = await getPayoutEligibility(db, acct);
      expect(eligibility.bufferEstablished).toBe(true);
      // Withdrawable is total profit MINUS the protected buffer.
      expect(eligibility.grossWithdrawableMicros).toBe(profit - $(c.buffer));
    });
  }
});

describe('90/10 split and the money invariant hold to the micro', () => {
  async function approveAndCheck(gross: number): Promise<void> {
    const acct = await makeFunded('pb-core-100000', { sizeUsd: 100_000, profit: $(50_000), winDays: 5 });
    const before = (await db.select().from(accounts).where(eq(accounts.id, acct)))[0]!.balanceMicros;
    const { account } = await getPayoutEligibility(db, acct);
    const req = await requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: gross, idempotencyKey: `inv-${acct}-${gross}`, actor: SYSTEM_ACTOR });
    const approved = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });

    // trader + firm = gross, exactly, all integers.
    const trader = approved.traderShareMicros!;
    const firm = approved.firmShareMicros!;
    expect(Number.isInteger(trader)).toBe(true);
    expect(Number.isInteger(firm)).toBe(true);
    expect(trader + firm).toBe(gross);
    expect(approved.balanceAdjustmentMicros).toBe(gross);

    // pre − debit = post (the FULL gross leaves the account).
    const after = (await db.select().from(accounts).where(eq(accounts.id, acct)))[0]!.balanceMicros;
    expect(before - gross).toBe(after);

    // The ledger DEBIT reconstructs the same accounting.
    const [debit] = (await db.select().from(payoutLedger).where(eq(payoutLedger.payoutRequestId, req.id))).filter((l) => l.entryType === 'DEBIT');
    expect(debit!.balanceBeforeMicros - gross).toBe(debit!.balanceAfterMicros);
    expect(debit!.traderShareMicros! + debit!.firmShareMicros!).toBe(gross);
  }

  it('a clean $1,000 splits 900/100', async () => {
    const acct = await makeFunded('pb-core-100000', { sizeUsd: 100_000, profit: $(50_000), winDays: 5 });
    const { account } = await getPayoutEligibility(db, acct);
    const req = await requestPayout(db, { accountId: acct, userId: account.userId, requestedGrossMicros: $(1000), idempotencyKey: `clean-${acct}`, actor: SYSTEM_ACTOR });
    const approved = await approvePayout(db, { payoutRequestId: req.id, actor: SYSTEM_ACTOR });
    expect(approved.traderShareMicros).toBe($(900));
    expect(approved.firmShareMicros).toBe($(100));
  });

  it('an amount whose 90% is not a whole micro loses no money (firm absorbs the remainder)', async () => {
    // $250.000001 → 0.9× = 225.0000009 → rounds to 225000001; firm = 25000000.
    const gross = $(250) + 1;
    await approveAndCheck(gross);
  });

  it('a large odd amount still reconciles exactly', async () => {
    await approveAndCheck($(3_333.333333)); // 3_333_333_333 micros
  });
});
