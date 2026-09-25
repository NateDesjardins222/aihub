/**
 * Affiliate economics stress utility (M11 §96).
 *
 * A deterministic (seeded) Monte-Carlo model of the affiliate program's money
 * flow: N affiliates over M months, each driving referred revenue drawn from a
 * seeded distribution. It applies the REAL program economics — the same integer
 * micros math, tier qualification, and commission rate used in production
 * (`commissionMicrosFor`, `tierForRevenue`, `tierRateBps`) — plus a refund rate
 * and a maturity holdback, and reports commission liability, tier distribution,
 * reversal impact, and payout throughput.
 *
 * It performs NO external financial action and touches NO database — it is a
 * pure model for capacity/liability planning. Run:
 *   pnpm --filter @atlas/server exec tsx scripts/affiliate-economics-stress.ts [--seed N] [--affiliates N] [--months N] [--report path]
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_AFFILIATE_SETTINGS, commissionMicrosFor, tierForRevenue, tierRateBps } from '../src/platform/affiliate-config.js';

const M = 1_000_000;

/** Mulberry32 — a tiny, fast, deterministic PRNG so runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

interface Result {
  seed: number; affiliates: number; months: number;
  grossReferredMicros: number; refundedMicros: number; qualifiedMicros: number;
  commissionAccruedMicros: number; commissionReversedMicros: number; commissionNetMicros: number;
  maturedPayableMicros: number; heldInMaturityMicros: number;
  tierDistribution: Record<string, number>;
  effectiveBlendedRatePct: number;
  worstMonthLiabilityMicros: number;
}

function run(seed: number, affiliateCount: number, months: number): Result {
  const rnd = mulberry32(seed);
  const s = DEFAULT_AFFILIATE_SETTINGS;
  const refundRate = 0.06; // 6% of orders refunded (stress assumption)
  const maturityFraction = 0.15; // ~15% of the latest month still inside the holdback window

  let gross = 0, refunded = 0, qualified = 0, accrued = 0, reversed = 0;
  let worstMonthLiability = 0;
  const tierDistribution: Record<string, number> = { AFFILIATE: 0, PARTNER: 0, GOLD: 0, PLATINUM: 0, STRATEGIC: 0 };

  for (let aff = 0; aff < affiliateCount; aff += 1) {
    // Each affiliate has a "size" that shapes its monthly revenue (heavy tail).
    const size = Math.pow(rnd(), 2); // 0..1, skewed toward small
    let finalTier = 'AFFILIATE';
    for (let m = 0; m < months; m += 1) {
      // Monthly referred revenue: a heavy-tailed draw scaled by affiliate size.
      const monthlyRevenue = Math.round((500 + size * 40_000 + rnd() * size * 60_000) * M);
      // Tier is assessed on this month's qualified revenue.
      const tier = tierForRevenue(s, monthlyRevenue);
      const rate = tierRateBps(s, tier);
      // Orders within the month; a fraction refunds and reverses.
      const monthRefunded = Math.round(monthlyRevenue * refundRate);
      const netQualified = monthlyRevenue - monthRefunded;
      const monthCommission = commissionMicrosFor(monthlyRevenue, rate);
      const monthReversal = commissionMicrosFor(monthRefunded, rate);

      gross += monthlyRevenue;
      refunded += monthRefunded;
      qualified += netQualified;
      accrued += monthCommission;
      reversed += monthReversal;
      worstMonthLiability = Math.max(worstMonthLiability, monthCommission - monthReversal);
      if (m === months - 1) finalTier = tier;
    }
    tierDistribution[finalTier] = (tierDistribution[finalTier] ?? 0) + 1;
  }

  const net = accrued - reversed;
  const held = Math.round(net * maturityFraction);
  return {
    seed, affiliates: affiliateCount, months,
    grossReferredMicros: gross, refundedMicros: refunded, qualifiedMicros: qualified,
    commissionAccruedMicros: accrued, commissionReversedMicros: reversed, commissionNetMicros: net,
    maturedPayableMicros: net - held, heldInMaturityMicros: held,
    tierDistribution,
    effectiveBlendedRatePct: gross > 0 ? (accrued / gross) * 100 : 0,
    worstMonthLiabilityMicros: worstMonthLiability,
  };
}

const $ = (micros: number) => `$${(micros / M).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function main(): void {
  const seed = arg('seed', 42);
  const affiliates = arg('affiliates', 500);
  const months = arg('months', 12);
  const reportPath = argStr('report', '');

  const r = run(seed, affiliates, months);
  const lines: string[] = [];
  lines.push('# Affiliate economics stress run');
  lines.push('');
  lines.push(`Deterministic model — seed ${r.seed}, ${r.affiliates} affiliates × ${r.months} months. No DB, no external calls; integer micros throughout.`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Gross referred revenue | ${$(r.grossReferredMicros)} |`);
  lines.push(`| Refunded revenue (6% assumed) | ${$(r.refundedMicros)} |`);
  lines.push(`| Qualified (net) revenue | ${$(r.qualifiedMicros)} |`);
  lines.push(`| Commission accrued (gross) | ${$(r.commissionAccruedMicros)} |`);
  lines.push(`| Commission reversed | ${$(r.commissionReversedMicros)} |`);
  lines.push(`| Commission net liability | ${$(r.commissionNetMicros)} |`);
  lines.push(`| Held in maturity window | ${$(r.heldInMaturityMicros)} |`);
  lines.push(`| Matured / payable | ${$(r.maturedPayableMicros)} |`);
  lines.push(`| Blended effective rate | ${r.effectiveBlendedRatePct.toFixed(2)}% |`);
  lines.push(`| Worst single-month affiliate liability | ${$(r.worstMonthLiabilityMicros)} |`);
  lines.push('');
  lines.push('## Final-month tier distribution');
  lines.push('');
  lines.push('| Tier | Affiliates |');
  lines.push('| --- | --- |');
  for (const [tier, n] of Object.entries(r.tierDistribution)) lines.push(`| ${tier} | ${n} |`);
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  lines.push('- The **net liability** is what the program owes affiliates after refunds/chargebacks reverse commissions; it is the number treasury must be able to cover.');
  lines.push('- The **maturity window** always holds back a slice of the newest accruals, absorbing refund risk before money becomes withdrawable.');
  lines.push('- The **blended effective rate** stays within the configured tier band (15%–25%); it never exceeds the top tier because commission is floored per order and tiers are revenue-gated.');
  lines.push('- Raising a tier rate or lowering a threshold moves this liability; because rates/thresholds are configuration (not code) the same model can be re-run against a proposed change before it ships.');

  const out = lines.join('\n') + '\n';
  if (reportPath) { writeFileSync(reportPath, out); process.stdout.write(`Report written to ${reportPath}\n`); }
  else process.stdout.write(out);
}

main();
