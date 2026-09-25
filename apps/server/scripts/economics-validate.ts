/**
 * M13.0 economics engine — validation runs (architecture/model checks, NOT predictions).
 *
 *   pnpm --filter @atlas/server exec tsx scripts/economics-validate.ts
 *
 * Runs the required scale cases and two stress scenarios and prints the headline
 * figures. Pure and deterministic; no DB, no production side effects.
 */
import { runEconomics, type ScenarioName } from '../src/platform/economics/index.js';

const M = 1_000_000;
const usd = (m: number): string => `$${Math.round(m / M).toLocaleString('en-US')}`;
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function line(label: string, scenario: ScenarioName, customers: number, horizonDays: number): void {
  const t0 = Date.now();
  const b = runEconomics({ scenario, seed: 2026, customers, horizonDays, trials: 30 });
  const r = b.result;
  const ms = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(26)} gross ${usd(r.grossSalesMicros).padStart(12)} · net ${usd(r.netRevenueMicros).padStart(12)} · ` +
    `funded ${String(r.fundedAccounts).padStart(6)} · payoutRcp ${String(r.payoutRecipients).padStart(5)} · ` +
    `traderPayout ${usd(r.payouts.traderShareMicros).padStart(12)} · affiliate ${usd(r.affiliate.netCommissionExpenseMicros).padStart(10)} · ` +
    `contribution ${usd(r.contributionMicros).padStart(13)} (${pct(r.contributionMargin).padStart(7)}) · ` +
    `reserve ${usd(r.treasury.requiredReserveMicros).padStart(11)} · distributable ${usd(r.treasury.distributableCashMicros).padStart(13)} · ` +
    `P(neg) ${pct(b.monteCarlo.probContributionNegative)} · P(liq) ${pct(b.monteCarlo.probLiquidityStress)} · ${ms}ms`,
  );
}

console.log('=== M13.0 economics validation runs (NOT predictions) ===');
console.log('-- scale (BASE) --');
line('BASE 100c / 90d', 'BASE', 100, 90);
line('BASE 1,000c / 90d', 'BASE', 1000, 90);
line('BASE 5,000c / 180d', 'BASE', 5000, 180);
line('BASE 10,000c / 365d', 'BASE', 10_000, 365);
console.log('-- stress (5,000c / 180d) --');
line('PAYOUT_STRESS', 'PAYOUT_STRESS', 5000, 180);
line('COMBINED_DOWNSIDE', 'COMBINED_DOWNSIDE', 5000, 180);
console.log('=== done ===');
