/**
 * Property / randomized money invariants for the payout core.
 *
 * Over thousands of random funded-account states and requests, the invariants
 * the brief demands must ALWAYS hold — there is no input that breaks them:
 *   - trader share + firm share reconciles to the gross, exactly;
 *   - withdrawable is never negative and never dips into the protected buffer;
 *   - a resolved payout never exceeds min(withdrawable, cap) and is ≥ the min;
 *   - an ineligible or out-of-bounds request resolves to a rejection, not money.
 */
import { describe, expect, it } from 'vitest';
import {
  MICROS,
  type PayoutPolicy,
  evaluatePayoutEligibility,
  grossWithdrawableMicros,
  resolvePayoutRequest,
  splitAccounting,
  type DayStat,
} from './payout-core.js';
import { mulberry32 } from './economics-sim.js';

const rng = mulberry32(20260924);
const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

function randomPolicy(): PayoutPolicy {
  const model = (['CORE', 'SELECT', 'DAILY'] as const)[randInt(0, 2)]!;
  return {
    model,
    profitSplitPercent: [0.8, 0.85, 0.9, 0.95][randInt(0, 3)]!,
    activationFeeMicros: 0,
    winningDayThresholdMicros: 150 * MICROS,
    requiredWinningDays: randInt(3, 6),
    payoutConsistencyThreshold: model === 'SELECT' ? 0.4 : null,
    fundedBufferMicros: model === 'DAILY' ? randInt(1, 4) * 1000 * MICROS : 0,
    requestCaps: { minRequestMicros: randInt(1, 5) * 100 * MICROS, maxRequestMicrosByOrdinal: [randInt(1, 5) * 1000 * MICROS] },
  };
}

describe('splitAccounting reconciles for any gross and split', () => {
  it('trader + firm == gross, for 5,000 random draws', () => {
    for (let i = 0; i < 5000; i += 1) {
      const gross = randInt(0, 10_000_000);
      const split = [0.8, 0.85, 0.9, 0.95][randInt(0, 3)]!;
      const s = splitAccounting(gross, split);
      expect(s.traderShareMicros + s.firmShareMicros).toBe(gross);
      expect(s.balanceAdjustmentMicros).toBe(gross);
      expect(s.traderShareMicros).toBeGreaterThanOrEqual(0);
      expect(s.firmShareMicros).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('withdrawable and resolution never violate the bounds', () => {
  it('holds across 3,000 random states', () => {
    for (let i = 0; i < 3000; i += 1) {
      const policy = randomPolicy();
      const startingBalanceMicros = randInt(25, 300) * 1000 * MICROS;
      const balanceMicros = startingBalanceMicros + randInt(-2000, 8000) * MICROS;
      const days: DayStat[] = Array.from({ length: randInt(0, 10) }, (_, d) => ({
        tradeDate: `2026-03-${String(d + 1).padStart(2, '0')}`,
        netMicros: randInt(-100, 400) * MICROS,
      }));
      const withdrawable = grossWithdrawableMicros(balanceMicros, startingBalanceMicros, policy.fundedBufferMicros);

      // Withdrawable is never negative and never reaches into the buffer.
      expect(withdrawable).toBeGreaterThanOrEqual(0);
      const totalNet = balanceMicros - startingBalanceMicros;
      if (policy.fundedBufferMicros > 0 && totalNet > 0) {
        expect(withdrawable).toBeLessThanOrEqual(Math.max(0, totalNet - policy.fundedBufferMicros));
      }

      const elig = evaluatePayoutEligibility(
        {
          policy,
          balanceMicros,
          startingBalanceMicros,
          days,
          cycleStartDate: null,
          dailyModeUnlocked: rng() < 0.5,
          accountStatus: 'ACTIVE',
          adminHold: null,
          hold: null,
          hasPendingRequest: false,
        },
        1,
      );

      const requested = randInt(0, 6000) * MICROS;
      const res = resolvePayoutRequest(elig, policy, requested, balanceMicros);
      if (res.ok) {
        // A resolved payout is within every bound and reconciles.
        expect(elig.state).toBe('ELIGIBLE');
        expect(requested).toBeGreaterThanOrEqual(elig.minRequestMicros);
        expect(requested).toBeLessThanOrEqual(elig.maxRequestMicros);
        expect(requested).toBeLessThanOrEqual(elig.grossWithdrawableMicros);
        expect(res.accounting.traderShareMicros + res.accounting.firmShareMicros).toBe(requested);
        expect(res.balanceAfterMicros).toBe(balanceMicros - requested);
        // The buffer survives: balance after is still at least starting + buffer.
        if (policy.fundedBufferMicros > 0) {
          expect(res.balanceAfterMicros).toBeGreaterThanOrEqual(startingBalanceMicros + policy.fundedBufferMicros);
        }
      } else {
        // A rejection moves no money — there is nothing to assert about balance
        // because resolve returns no accounting; the invariant is that we never
        // returned an ok result outside the bounds (covered above).
        expect(res.reason).toBeTruthy();
      }
    }
  });
});
