/**
 * Phase 9 — money split & rounding invariants (pure, deterministic, no DB).
 *
 * The payout split is where fractions of a dollar are created, so it is where
 * floating-point drift or a wrong rounding rule would silently leak money. This
 * suite pins the invariants of `splitAccounting` / `roundHalfEven` directly:
 *
 *   trader share + firm share == gross            (no money created or lost)
 *   balance debit               == gross          (the account is debited the full gross)
 *   trader share                == round-half-even(gross × split)
 *   firm share                  == gross − trader  (exact integer complement)
 *
 * over a wide range of gross amounts, including values that do NOT divide
 * cleanly at 90/10. Everything is integer micro-dollars; there is no binary
 * floating-point money representation to drift.
 *
 * The end-to-end financial trace (purchase → funded → payout → PAID → debit →
 * cycle → certificate with a $0.00 unexplained delta) is proven against the real
 * services by `golden-path.core50k.test.ts`; payout caps / 50%-profit / Select
 * consistency / Daily buffer by `payout-core.test.ts`; settlement idempotency,
 * lost-ack and reconciliation by `payout-operations.test.ts`. This file guards
 * the arithmetic those depend on. See docs/company/FINANCIAL_INVARIANTS.md.
 */
import { describe, expect, it } from 'vitest';
import { roundHalfEven, splitAccounting } from './payout-core.js';

const M = 1_000_000;
const SPLIT = 0.9; // 90% trader / 10% firm — the locked shared payout term.

describe('roundHalfEven', () => {
  it('rounds halves to the nearest even integer (banker’s rounding), no FP drift', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(-0.5)).toBe(0); // nearest even is 0
    expect(roundHalfEven(-1.5)).toBe(-2);
    // Non-half fractions round normally.
    expect(roundHalfEven(2.4)).toBe(2);
    expect(roundHalfEven(2.6)).toBe(3);
  });
});

describe('splitAccounting — money conservation & full-gross debit', () => {
  // A spread of gross amounts: round dollars, awkward cents, primes, and values
  // whose 90/10 split lands exactly on a half micro-dollar.
  const grosses = [
    0, 1, 5, 9, 10, 15, 99, 100, 101, 250 * M, 333, 1_000_000, 1_000_001,
    500 * M, 1_000 * M, 2_000 * M, 3_500 * M, 5_000 * M, 123_456_789, 999_999,
  ];

  for (const gross of grosses) {
    it(`gross=${gross}µ$ : trader + firm == gross, debit == gross`, () => {
      const s = splitAccounting(gross, SPLIT);
      // No money created or destroyed: the two shares are an exact partition.
      expect(s.traderShareMicros + s.firmShareMicros).toBe(gross);
      // The account is debited the FULL gross (trader is paid, firm keeps the rest).
      expect(s.balanceAdjustmentMicros).toBe(gross);
      // The trader is actually paid their share.
      expect(s.actualPayoutMicros).toBe(s.traderShareMicros);
      // Trader share is the banker's-rounded 90%; firm is the exact complement.
      expect(s.traderShareMicros).toBe(roundHalfEven(gross * SPLIT));
      expect(s.firmShareMicros).toBe(gross - s.traderShareMicros);
      // No negative or impossible shares for a non-negative gross.
      expect(s.traderShareMicros).toBeGreaterThanOrEqual(0);
      expect(s.firmShareMicros).toBeGreaterThanOrEqual(0);
      // Shares are whole micro-dollars (no fractional cents / FP artifacts).
      expect(Number.isInteger(s.traderShareMicros)).toBe(true);
      expect(Number.isInteger(s.firmShareMicros)).toBe(true);
    });
  }

  it('the canonical $500 payout splits exactly $450 / $50 at 90/10', () => {
    const s = splitAccounting(500 * M, SPLIT);
    expect(s.traderShareMicros).toBe(450 * M);
    expect(s.firmShareMicros).toBe(50 * M);
    expect(s.balanceAdjustmentMicros).toBe(500 * M);
  });

  it('an odd gross that cannot divide cleanly still conserves every micro-dollar', () => {
    // $0.000001 above a clean split — the rounding must not lose or invent a micro.
    const gross = 1_000_001; // 1,000,001 µ$
    const s = splitAccounting(gross, SPLIT);
    expect(s.traderShareMicros + s.firmShareMicros).toBe(gross);
    expect(s.balanceAdjustmentMicros).toBe(gross);
  });
});
