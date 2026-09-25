/**
 * The public catalog is the single source of truth for the marketing site, so its
 * numbers must exactly match the product specification. These tests are the guard
 * against pricing/rule drift on the flagship brand surface.
 */
import { describe, expect, it } from 'vitest';
import { FAMILIES, ALL_ACCOUNTS, family, price, usd } from './catalog';

describe('shape', () => {
  it('has three families and ten accounts', () => {
    expect(FAMILIES.map((f) => f.key)).toEqual(['CORE', 'SELECT', 'DAILY']);
    expect(family('CORE').accounts.length).toBe(4);
    expect(family('SELECT').accounts.length).toBe(3);
    expect(family('DAILY').accounts.length).toBe(3);
    expect(ALL_ACCOUNTS.length).toBe(10);
  });

  it('every family pays a 90% split with a $0 activation fee', () => {
    for (const f of FAMILIES) {
      expect(f.splitPct).toBe(90);
      expect(f.activationFeeUsd).toBe(0);
    }
  });
});

describe('exact terms match the specification', () => {
  it('Core', () => {
    const c = family('CORE');
    expect(c.evalConsistencyPct).toBe(50);
    expect(c.fundedConsistencyPct).toBeNull();
    const by = Object.fromEntries(c.accounts.map((a) => [a.size, a]));
    expect(by['25K']).toMatchObject({ priceUsd: 65, targetUsd: 1_500, eodDrawdownUsd: 1_000, minis: 2, micros: 20 });
    expect(by['50K']).toMatchObject({ priceUsd: 95, targetUsd: 3_000, eodDrawdownUsd: 2_000, minis: 5, micros: 50 });
    expect(by['100K']).toMatchObject({ priceUsd: 170, targetUsd: 6_000, eodDrawdownUsd: 4_000, minis: 10, micros: 100 });
    expect(by['300K']).toMatchObject({ priceUsd: 599, targetUsd: 15_000, eodDrawdownUsd: 10_000, minis: 20, micros: 200, gold: true });
  });

  it('Select', () => {
    const s = family('SELECT');
    expect(s.evalConsistencyPct).toBe(40);
    expect(s.fundedConsistencyPct).toBe(40);
    const by = Object.fromEntries(s.accounts.map((a) => [a.size, a]));
    expect(by['25K']).toMatchObject({ priceUsd: 85, targetUsd: 1_500, eodDrawdownUsd: 1_250, minis: 3, micros: 30 });
    expect(by['50K']).toMatchObject({ priceUsd: 135, targetUsd: 3_000, eodDrawdownUsd: 2_500, minis: 7, micros: 70 });
    expect(by['100K']).toMatchObject({ priceUsd: 230, targetUsd: 6_000, eodDrawdownUsd: 5_000, minis: 15, micros: 150 });
  });

  it('Daily (with buffers)', () => {
    const d = family('DAILY');
    expect(d.evalConsistencyPct).toBe(40);
    expect(d.fundedConsistencyPct).toBeNull();
    const by = Object.fromEntries(d.accounts.map((a) => [a.size, a]));
    expect(by['25K']).toMatchObject({ priceUsd: 90, targetUsd: 1_500, eodDrawdownUsd: 1_000, minis: 2, micros: 20, bufferUsd: 1_000 });
    expect(by['50K']).toMatchObject({ priceUsd: 145, targetUsd: 3_000, eodDrawdownUsd: 2_000, minis: 5, micros: 50, bufferUsd: 2_000 });
    expect(by['100K']).toMatchObject({ priceUsd: 250, targetUsd: 6_000, eodDrawdownUsd: 4_000, minis: 10, micros: 100, bufferUsd: 4_000 });
  });

  it('only the 300K Core account is marked gold', () => {
    const golds = ALL_ACCOUNTS.filter((a) => a.gold);
    expect(golds.length).toBe(1);
    expect(golds[0]).toMatchObject({ family: 'CORE', size: '300K' });
  });
});

describe('formatting', () => {
  it('formats prices and dollars without cents', () => {
    expect(price(65)).toBe('$65');
    expect(usd(15_000)).toBe('$15,000');
  });
});
