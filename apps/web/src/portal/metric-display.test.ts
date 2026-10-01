/**
 * Error ≠ zero for count metrics (customer-system hardening §4B / CPI-2).
 *
 * The dashboard payout badge used to collapse a failed `/certificates` fetch to
 * `0`, telling a funded trader they had never been paid. These cases pin the fix:
 * an error reads as unknown ("—"), a real zero reads as "0", and the two are
 * never confused.
 */
import { describe, expect, it } from 'vitest';
import { countBadge } from './metric-display';

describe('countBadge — error is not zero (§4B)', () => {
  it('CORE DEFECT: a fetch error renders "—", never "0"', () => {
    expect(countBadge(null, true)).toBe('—');
    // Even if a stale count lingered, an error must not present it as current 0.
    expect(countBadge(0, true)).toBe('—');
  });

  it('a legitimate zero renders "0", distinct from the error dash', () => {
    expect(countBadge(0, false)).toBe('0');
  });

  it('a loaded count renders its number', () => {
    expect(countBadge(3, false)).toBe('3');
    expect(countBadge(12, false)).toBe('12');
  });

  it('still-loading (null, no error) renders "—", not a premature zero', () => {
    expect(countBadge(null, false)).toBe('—');
  });

  it('the error dash and a real zero are never the same glyph', () => {
    expect(countBadge(0, true)).not.toBe(countBadge(0, false));
  });
});
