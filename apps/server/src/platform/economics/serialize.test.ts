/**
 * Economics exports + authoritative config — well-formed, reconciled, and matching the
 * authoritative catalog. Pure, no DB.
 */
import { describe, expect, it } from 'vitest';
import { MICROS } from '../payout-core.js';
import { AUTHORITATIVE, loadAuthoritativeProducts, runEconomics, serialize } from './index.js';

function bundle() {
  return runEconomics({ scenario: 'BASE', seed: 2026, customers: 3000, horizonDays: 180, trials: 15 });
}

describe('authoritative config is faithful to the catalog + payout engine', () => {
  it('exposes the authoritative constants', () => {
    expect(AUTHORITATIVE.maxPayoutCycles).toBe(5);
    expect(AUTHORITATIVE.requiredWinningDays).toBe(5);
    expect(AUTHORITATIVE.profitSplitPercent).toBe(0.9);
    expect(AUTHORITATIVE.activationFeeMicros).toBe(0);
    expect(AUTHORITATIVE.minRequestMicros).toBe(250 * MICROS);
    expect(AUTHORITATIVE.winningDayThresholdMicros).toBe(150 * MICROS);
  });
  it('loads exactly the ten products with the authoritative caps', () => {
    const p = loadAuthoritativeProducts();
    expect(p.map((x) => x.key).sort()).toEqual(
      ['core-100k', 'core-25k', 'core-300k', 'core-50k', 'daily-100k', 'daily-25k', 'daily-50k', 'select-100k', 'select-25k', 'select-50k'],
    );
    expect(p.find((x) => x.key === 'select-100k')!.payoutCapMicros).toBe(3500 * MICROS);
  });
});

describe('exports are well-formed and reconcile', () => {
  it('summary CSV has a header and one data row', () => {
    const csv = serialize.summaryCsv(bundle());
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('contributionUsd');
    expect(lines[1]!.split(',').length).toBe(lines[0]!.split(',').length);
  });
  it('product CSV has a row per product (10)', () => {
    const csv = serialize.productCsv(bundle());
    expect(csv.split('\n')).toHaveLength(11); // header + 10
  });
  it('timeline CSV has a row per modelled month', () => {
    const b = bundle();
    const csv = serialize.timelineCsv(b);
    expect(csv.split('\n')).toHaveLength(1 + b.result.timeline.length);
  });
  it('assumptions CSV is key/value and includes an operating line', () => {
    const csv = serialize.assumptionsCsv(bundle());
    expect(csv.startsWith('key,value')).toBe(true);
    expect(csv).toContain('operating:');
    expect(csv).toContain('passRate');
  });
  it('JSON bundle round-trips and preserves exact micros', () => {
    const b = bundle();
    const parsed = JSON.parse(serialize.bundleJson(b)) as typeof b;
    expect(parsed.result.contributionMicros).toBe(b.result.contributionMicros);
    expect(parsed.engineVersion).toBe(b.engineVersion);
    expect(parsed.products).toHaveLength(10);
  });
});
