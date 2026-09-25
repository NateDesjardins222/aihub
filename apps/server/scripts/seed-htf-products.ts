/**
 * Seed the 10 LOCKED Happy Trader products into immutable product configuration.
 *
 * Core 25K/$65, 50K/$95, 100K/$170, 300K Gold/$599; Select 25K/$85, 50K/$135,
 * 100K/$230; Daily 25K/$90, 50K/$145, 100K/$250. Each evaluation names a funded
 * destination (published first). payoutRules match the payout engine: 90% split,
 * $0 activation, 5 winning days >= $150; Core/Select/Daily consistency and the
 * Daily buffers. Prices and terms live in the version config, never hard-coded in
 * the app. Idempotent: publishing identical content is a no-op.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/seed-htf-products.ts
 */
import {
  ACTIVATION_FEE_USD,
  MIN_PAYOUT_REQUEST_USD,
  PAYOUT_REQUEST_CAP_USD_BY_SIZE,
  PROFIT_SPLIT_PCT,
  REQUIRED_WINNING_DAYS,
  WINNING_DAY_THRESHOLD_USD,
  family as catalogFamily,
  type FamilyKey,
} from '@atlas/contracts';
import { createDb } from '../src/db/client.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';
import { publishProfileVersion } from '../src/platform/profiles.js';

const M = 1_000_000;
const K = 1000;

type Line = FamilyKey;

// Prices, payout consistency and Daily buffers are read from the authoritative
// shared catalog (@atlas/contracts) so the DB seed can never diverge from the
// public site or the economics engine.
const LINES: Record<Line, { evalConsistency: number; payoutConsistency: number | null; buffers: Record<number, number>; sizes: Record<number, number> }> =
  buildLines();

function buildLines(): Record<Line, { evalConsistency: number; payoutConsistency: number | null; buffers: Record<number, number>; sizes: Record<number, number> }> {
  const out = {} as Record<Line, { evalConsistency: number; payoutConsistency: number | null; buffers: Record<number, number>; sizes: Record<number, number> }>;
  for (const key of ['CORE', 'SELECT', 'DAILY'] as Line[]) {
    const fam = catalogFamily(key);
    const buffers: Record<number, number> = {};
    const sizes: Record<number, number> = {};
    for (const a of fam.accounts) {
      sizes[a.sizeUsd / K] = a.priceUsd;
      if (a.bufferUsd) buffers[a.sizeUsd / K] = a.bufferUsd;
    }
    out[key] = {
      evalConsistency: fam.evalConsistencyPct / 100,
      payoutConsistency: fam.fundedConsistencyPct === null ? null : fam.fundedConsistencyPct / 100,
      buffers,
      sizes,
    };
  }
  return out;
}

// Launch payout request caps by account size come from the shared catalog
// (docs/account-lifecycle-ux-v1 §5). A flat cap per size (one element applies to
// every ordinal); the request ceiling further composes min(eligible, this cap,
// 50% of eligible) in the payout engine.
const REQUEST_CAP_BY_SIZE_K: Record<number, number> = Object.fromEntries(
  Object.entries(PAYOUT_REQUEST_CAP_USD_BY_SIZE).map(([sizeUsd, cap]) => [Number(sizeUsd) / K, cap]),
);

function payoutRules(line: Line, sizeK: number) {
  const capMicros = (REQUEST_CAP_BY_SIZE_K[sizeK] ?? 1000) * M;
  return {
    model: line,
    profitSplitPercent: PROFIT_SPLIT_PCT / 100,
    activationFeeMicros: ACTIVATION_FEE_USD * M,
    winningDayThresholdMicros: WINNING_DAY_THRESHOLD_USD * M,
    requiredWinningDays: REQUIRED_WINNING_DAYS,
    payoutConsistencyThreshold: LINES[line].payoutConsistency,
    fundedBufferMicros: (LINES[line].buffers[sizeK] ?? 0) * M,
    requestCaps: { minRequestMicros: MIN_PAYOUT_REQUEST_USD * M, maxRequestMicrosByOrdinal: [capMicros] },
  };
}

function evalRules(line: Line, sizeK: number) {
  const size = sizeK * K * M;
  return {
    accountSizeMicros: size,
    profitTargetMicros: Math.round(0.06 * size),
    maxLossMicros: Math.round(0.04 * size),
    drawdownType: 'STATIC',
    trailingLockAtMicros: null,
    dailyLossLimitMicros: line === 'DAILY' ? Math.round(0.02 * size) : null,
    dailyLossPolicy: 'LOCK_DAY',
    consistencyFormula: 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: LINES[line].evalConsistency,
    minTradingDays: 0,
    minWinningDays: 0,
    maxTradingDays: null,
    minDailyPnlToCountMicros: 0,
    minWinningDayPnlMicros: 150 * M,
    maxContracts: sizeK <= 25 ? 10 : sizeK <= 50 ? 20 : sizeK <= 100 ? 40 : 100,
    microsCountAsFraction: false,
    flattenOnBreach: true,
  };
}

function fundedRules(line: Line, sizeK: number) {
  const size = sizeK * K * M;
  return { ...evalRules(line, sizeK), profitTargetMicros: 0, maxLossMicros: Math.round(0.04 * size), drawdownType: 'STATIC' };
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas';
  const { db, sql } = createDb(url);
  try {
    const organizationId = await defaultOrganizationId(db);
    let published = 0;
    for (const line of Object.keys(LINES) as Line[]) {
      for (const sizeK of Object.keys(LINES[line].sizes).map(Number)) {
        const price = LINES[line].sizes[sizeK]!;
        const label = line === 'CORE' && sizeK === 300 ? 'Core Gold' : line.charAt(0) + line.slice(1).toLowerCase();
        const evalKey = `htf-${line.toLowerCase()}-${sizeK}k`;
        const fundedKey = `${evalKey}-funded`;

        await publishProfileVersion(db, {
          organizationId,
          key: fundedKey,
          name: `HTF ${label} ${sizeK}K (Funded)`,
          accountType: 'FUNDED_SIM',
          config: {
            rules: fundedRules(line, sizeK),
            execution: null,
            instruments: { allowed: null, maxContracts: null, perInstrument: {} },
            display: { startingBalanceMicros: sizeK * K * M },
            payoutRules: payoutRules(line, sizeK),
            fundedDestinationKey: null,
            whopPlanId: null,
          },
        }).catch(() => undefined);

        await publishProfileVersion(db, {
          organizationId,
          key: evalKey,
          name: `HTF ${label} ${sizeK}K`,
          accountType: 'EVALUATION',
          config: {
            rules: evalRules(line, sizeK),
            execution: null,
            instruments: { allowed: null, maxContracts: null, perInstrument: {} },
            display: { startingBalanceMicros: sizeK * K * M, priceMicros: price * M },
            payoutRules: payoutRules(line, sizeK),
            fundedDestinationKey: fundedKey,
            whopPlanId: `plan_${evalKey.replace(/-/g, '_')}`,
          },
        }).catch(() => undefined);
        published += 1;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`SEEDED ${published} HTF evaluation products (+ funded destinations)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
