/**
 * Portal V2 financial formatting (Product Rebuild Phase 1, STEP 10).
 * Ugly-value coverage: zero, negatives, > $100k, cents, nullish, clamping.
 */
import { describe, expect, it } from 'vitest';
import {
  MICROS_PER_DOLLAR, accountSizeLabel, clampPercent, formatMoney, formatPercent, maskAccountId, moneyTone,
} from './format';

const $ = (d: number): number => d * MICROS_PER_DOLLAR;

describe('formatMoney', () => {
  it('formats zero as $0', () => expect(formatMoney(0)).toBe('$0'));
  it('formats a round balance with commas', () => expect(formatMoney($(100000))).toBe('$100,000'));
  it('formats a large balance', () => expect(formatMoney($(1234567.5))).toBe('$1,234,567.5'));
  it('keeps cents', () => expect(formatMoney($(52480.25))).toBe('$52,480.25'));
  it('shows a leading minus on negatives', () => expect(formatMoney($(-4100))).toBe('-$4,100'));
  it('adds a + only when sign requested and positive', () => {
    expect(formatMoney($(2480), { sign: true })).toBe('+$2,480');
    expect(formatMoney($(-2480), { sign: true })).toBe('-$2,480');
    expect(formatMoney(0, { sign: true })).toBe('$0');
  });
  it('renders nullish / non-finite as em dash', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });
  it('never emits floating-point tails beyond 2 dp', () => {
    // $0.10 + $0.20 in micro space is exact (300000 micros) → "$0.3", no residue.
    expect(formatMoney($(0.1) + $(0.2))).toBe('$0.3');
    // A sub-cent micro amount rounds to 2 dp, never a long tail.
    expect(formatMoney(1_000_001)).toBe('$1');
  });
});

describe('moneyTone', () => {
  it('is muted at zero / nullish', () => {
    expect(moneyTone(0)).toBe('muted');
    expect(moneyTone(null)).toBe('muted');
  });
  it('is positive above zero and negative below', () => {
    expect(moneyTone($(1))).toBe('positive');
    expect(moneyTone($(-1))).toBe('negative');
  });
});

describe('formatPercent', () => {
  it('formats a fraction', () => expect(formatPercent(0.582)).toBe('58.2%'));
  it('handles nullish', () => expect(formatPercent(null)).toBe('—'));
});

describe('clampPercent', () => {
  it('clamps below 0 to 0', () => expect(clampPercent(-20)).toBe(0));
  it('passes 0 through', () => expect(clampPercent(0)).toBe(0));
  it('passes an interior value through', () => expect(clampPercent(42.5)).toBe(42.5));
  it('clamps above 100 to 100', () => expect(clampPercent(140)).toBe(100));
  it('treats nullish/NaN as 0', () => {
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('accountSizeLabel', () => {
  it('labels round thousands as NNK', () => {
    expect(accountSizeLabel($(100000))).toBe('100K');
    expect(accountSizeLabel($(50000))).toBe('50K');
  });
  it('falls back to a plain amount for odd sizes', () => {
    expect(accountSizeLabel($(2500))).toBe('2,500');
  });
});

describe('maskAccountId', () => {
  it('shows the last four with bullets', () => expect(maskAccountId('HT-ACCT-881005')).toBe('•••• 1005'));
  it('handles nullish', () => expect(maskAccountId(null)).toBe('••••'));
});
