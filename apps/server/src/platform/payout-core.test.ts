/**
 * The payout engine's pure arithmetic — exhaustive, deterministic.
 *
 * Every money invariant the brief demands is asserted here against the pure
 * core, with no database in the way: Core/Select/Daily eligibility, the 90%
 * split, the Daily buffer, minimum/maximum requests, withdrawable amount,
 * multiple cycles, progressive caps, and the split-reconciliation invariant.
 */
import { describe, expect, it } from 'vitest';
import {
  MICROS,
  type PayoutPolicy,
  capForOrdinal,
  countQualifyingWinningDays,
  evaluatePayoutEligibility,
  grossWithdrawableMicros,
  parsePayoutPolicy,
  resolvePayoutRequest,
  roundHalfEven,
  splitAccounting,
  type DayStat,
} from './payout-core.js';

const $ = (dollars: number) => dollars * MICROS;

const CORE_50K: PayoutPolicy = parsePayoutPolicy({
  model: 'CORE',
  profitSplitPercent: 0.9,
  winningDayThresholdMicros: $(150),
  requiredWinningDays: 5,
  payoutConsistencyThreshold: null,
  fundedBufferMicros: 0,
  requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] },
});

const SELECT_50K: PayoutPolicy = parsePayoutPolicy({
  model: 'SELECT',
  profitSplitPercent: 0.9,
  winningDayThresholdMicros: $(150),
  requiredWinningDays: 5,
  payoutConsistencyThreshold: 0.4,
  fundedBufferMicros: 0,
  requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] },
});

const DAILY_50K: PayoutPolicy = parsePayoutPolicy({
  model: 'DAILY',
  profitSplitPercent: 0.9,
  winningDayThresholdMicros: $(150),
  requiredWinningDays: 5,
  payoutConsistencyThreshold: null,
  fundedBufferMicros: $(2000),
  requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(2000)] },
});

function winningDays(n: number, each = 200, startIndex = 1): DayStat[] {
  return Array.from({ length: n }, (_, i) => ({
    tradeDate: `2026-03-${String(startIndex + i).padStart(2, '0')}`,
    netMicros: $(each),
  }));
}

const CLEAN = {
  cycleStartDate: null as string | null,
  dailyModeUnlocked: false,
  accountStatus: 'ACTIVE',
  adminHold: null as string | null,
  hold: null as 'RISK' | 'FRAUD' | 'MANUAL' | null,
  hasPendingRequest: false,
};

describe('the 90% split reconciles to the gross, exactly', () => {
  it('trader + firm always equals gross, at every amount', () => {
    for (const cents of [0, 1, 249, 250, 1000, 1999, 2000, 33333, 999999, 1_234_567]) {
      const s = splitAccounting(cents, 0.9);
      expect(s.traderShareMicros + s.firmShareMicros).toBe(cents);
      expect(s.balanceAdjustmentMicros).toBe(cents);
      expect(s.actualPayoutMicros).toBe(s.traderShareMicros);
      expect(s.feesMicros).toBe(0);
    }
  });

  it('trader share is 90% with banker rounding, firm absorbs the remainder', () => {
    expect(splitAccounting($(1000), 0.9).traderShareMicros).toBe($(900));
    expect(splitAccounting($(1000), 0.9).firmShareMicros).toBe($(100));
    // 25 * 0.9 = 22.5 → banker's rounds to 22 (even); firm gets 3.
    expect(splitAccounting(25, 0.9)).toMatchObject({ traderShareMicros: 22, firmShareMicros: 3 });
    // 15 * 0.9 = 13.5 → rounds to 14 (even).
    expect(splitAccounting(15, 0.9).traderShareMicros).toBe(14);
  });

  it('roundHalfEven rounds halves to the nearest even integer', () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(2.4)).toBe(2);
    expect(roundHalfEven(2.6)).toBe(3);
  });
});

describe('withdrawable + progressive caps', () => {
  it('withdrawable is profit above the buffer, floored at zero', () => {
    expect(grossWithdrawableMicros($(53_500), $(50_000), $(2000))).toBe($(1500));
    expect(grossWithdrawableMicros($(50_500), $(50_000), $(2000))).toBe(0); // profit < buffer
    expect(grossWithdrawableMicros($(49_000), $(50_000), 0)).toBe(0); // loss
    expect(grossWithdrawableMicros($(52_000), $(50_000), 0)).toBe($(2000));
  });

  it('progressive caps pick the ordinal, clamping to the last (established) entry', () => {
    const p = parsePayoutPolicy({
      model: 'CORE',
      profitSplitPercent: 0.9,
      requestCaps: { minRequestMicros: $(250), maxRequestMicrosByOrdinal: [$(1000), $(1500), $(3000)] },
    });
    expect(capForOrdinal(p, 1)).toBe($(1000));
    expect(capForOrdinal(p, 2)).toBe($(1500));
    expect(capForOrdinal(p, 3)).toBe($(3000));
    expect(capForOrdinal(p, 9)).toBe($(3000)); // established cap
    expect(capForOrdinal(CORE_50K, 5)).toBe($(2000)); // flat cap
  });

  it('request ceiling = min(eligible, productCap, 50% of eligible)', () => {
    // 50% binds: withdrawable $3,000, cap $2,000 → floor(0.5×3,000)=$1,500 < cap.
    const fiftyBinds = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
      1,
    );
    expect(fiftyBinds.grossWithdrawableMicros).toBe($(3000));
    expect(fiftyBinds.maxRequestMicros).toBe($(1500)); // 50% < $2,000 cap

    // Cap binds: withdrawable $10,000 → 50% = $5,000, but the $2,000 cap is lower.
    const capBinds = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(60_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
      1,
    );
    expect(capBinds.grossWithdrawableMicros).toBe($(10_000));
    expect(capBinds.maxRequestMicros).toBe($(2000)); // cap < 50%
  });
});

describe('winning-day counting is per cycle, server side', () => {
  it('counts only qualifying days strictly after the cycle start', () => {
    const days: DayStat[] = [
      { tradeDate: '2026-03-01', netMicros: $(200) },
      { tradeDate: '2026-03-02', netMicros: $(140) }, // below $150 threshold
      { tradeDate: '2026-03-03', netMicros: $(150) }, // exactly threshold — counts
      { tradeDate: '2026-03-04', netMicros: $(300) },
    ];
    expect(countQualifyingWinningDays(days, null, $(150))).toBe(3);
    // A cycle that started on 03-03 excludes 03-01/02/03, leaving only 03-04.
    expect(countQualifyingWinningDays(days, '2026-03-03', $(150))).toBe(1);
  });
});

describe('CORE eligibility + multi-cycle', () => {
  it('needs 5 winning days, then is eligible and pays 90%', () => {
    const four = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(4), ...CLEAN },
      1,
    );
    expect(four.state).toBe('NOT_ELIGIBLE');
    expect(four.reasonCodes).toContain('INSUFFICIENT_WINNING_DAYS');

    const five = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
      1,
    );
    expect(five.state).toBe('ELIGIBLE');
    expect(five.reasonCodes).toEqual(['ELIGIBLE']);
    expect(five.grossWithdrawableMicros).toBe($(3000));

    const res = resolvePayoutRequest(five, CORE_50K, $(1000), $(53_000));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accounting.traderShareMicros).toBe($(900));
      expect(res.accounting.firmShareMicros).toBe($(100));
      expect(res.balanceAfterMicros).toBe($(52_000));
    }
  });

  it('a second cycle resets winning-day counting after a payout date', () => {
    // 8 winning days total; the first payout closed the cycle at 2026-03-05.
    const days = winningDays(8); // 03-01..03-08
    const second = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(54_000), startingBalanceMicros: $(50_000), days, cycleStartDate: '2026-03-05', dailyModeUnlocked: false, accountStatus: 'ACTIVE', adminHold: null, hold: null, hasPendingRequest: false },
      2,
    );
    // Only 03-06/07/08 count → 3 days, not enough for a second payout yet.
    expect(second.qualifyingWinningDays).toBe(3);
    expect(second.state).toBe('NOT_ELIGIBLE');
    expect(second.reasonCodes).toContain('INSUFFICIENT_WINNING_DAYS');
  });
});

describe('SELECT consistency blocks payout but never fails the account', () => {
  it('best day over 40% of total net is blocked, not failed', () => {
    // total net 3,000; best day 1,500 → 50% > 40%.
    const days = [...winningDays(5, 200), { tradeDate: '2026-03-20', netMicros: $(1500) }];
    const e = evaluatePayoutEligibility(
      { policy: SELECT_50K, balanceMicros: $(52_500), startingBalanceMicros: $(50_000), days, ...CLEAN },
      1,
    );
    expect(e.consistencyRatio).toBeCloseTo(1500 / 2500, 6);
    expect(e.state).toBe('NOT_ELIGIBLE');
    expect(e.reasonCodes).toContain('CONSISTENCY_NOT_MET');
    // Not an account-failure reason.
    expect(e.reasonCodes).not.toContain('ACCOUNT_FAILED');
  });

  it('is eligible when the best day is within 40%', () => {
    const days = winningDays(6, 200); // 6 even days, best 200 of total 1200 = 17%
    const e = evaluatePayoutEligibility(
      { policy: SELECT_50K, balanceMicros: $(51_200), startingBalanceMicros: $(50_000), days, ...CLEAN },
      1,
    );
    expect(e.state).toBe('ELIGIBLE');
  });
});

describe('DAILY buffer + daily-mode unlock', () => {
  it('requires winning days AND the buffer before unlocking', () => {
    // 5 winning days but profit ($1,500) below the $2,000 buffer → BUFFER_NOT_MET.
    const noBuffer = evaluatePayoutEligibility(
      { policy: DAILY_50K, balanceMicros: $(51_500), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
      1,
    );
    expect(noBuffer.state).toBe('NOT_ELIGIBLE');
    expect(noBuffer.reasonCodes).toContain('BUFFER_NOT_MET');

    // Buffer met and 5 winning days → unlocks, withdrawable = profit - buffer.
    const unlocked = evaluatePayoutEligibility(
      { policy: DAILY_50K, balanceMicros: $(53_500), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
      1,
    );
    expect(unlocked.state).toBe('ELIGIBLE');
    expect(unlocked.dailyModeUnlocked).toBe(true);
    expect(unlocked.grossWithdrawableMicros).toBe($(1500)); // 3,500 - 2,000

    // Request ceiling now composes the 50%-of-eligible rule: withdrawable $1,500
    // → max request floor(0.5 × 1,500) = $750. A $700 request is within it.
    expect(unlocked.maxRequestMicros).toBe($(750));
    const res = resolvePayoutRequest(unlocked, DAILY_50K, $(700), $(53_500));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.balanceAfterMicros).toBe($(52_800));
  });

  it('once unlocked, later payouts need no new winning days — buffer stays protected', () => {
    // Daily mode already unlocked; only 0 winning days in the new window.
    const later = evaluatePayoutEligibility(
      { policy: DAILY_50K, balanceMicros: $(52_500), startingBalanceMicros: $(50_000), days: winningDays(5), cycleStartDate: '2026-03-30', dailyModeUnlocked: true, accountStatus: 'ACTIVE', adminHold: null, hold: null, hasPendingRequest: false },
      2,
    );
    expect(later.qualifyingWinningDays).toBe(0);
    expect(later.state).toBe('ELIGIBLE'); // no winning-day gate once unlocked
    expect(later.grossWithdrawableMicros).toBe($(500)); // 2,500 - 2,000 buffer protected
    // Cannot withdraw into the buffer. With the 50%-of-eligible ceiling
    // (withdrawable $500 → max $250) a $600 request now binds on ABOVE_MAXIMUM
    // before the withdrawable gate; either way the buffer is protected.
    expect(later.maxRequestMicros).toBe($(250));
    const overdraw = resolvePayoutRequest(later, DAILY_50K, $(600), $(52_500));
    expect(overdraw.ok).toBe(false);
    if (!overdraw.ok) expect(overdraw.reason).toBe('ABOVE_MAXIMUM');
  });
});

describe('request bounds + account holds', () => {
  const eligible = evaluatePayoutEligibility(
    { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
    1,
  );

  it('rejects below minimum and above maximum without moving money', () => {
    expect(resolvePayoutRequest(eligible, CORE_50K, $(100), $(53_000))).toMatchObject({ ok: false, reason: 'BELOW_MINIMUM' });
    expect(resolvePayoutRequest(eligible, CORE_50K, $(2500), $(53_000))).toMatchObject({ ok: false, reason: 'ABOVE_MAXIMUM' });
  });

  it('a failed/locked account and holds are surfaced as reasons, not exceptions', () => {
    const failed = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN, accountStatus: 'FAILED' },
      1,
    );
    expect(failed.reasonCodes).toContain('ACCOUNT_FAILED');

    const held = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN, hold: 'FRAUD' },
      1,
    );
    expect(held.reasonCodes).toContain('FRAUD_HOLD');

    const pending = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(53_000), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN, hasPendingRequest: true },
      1,
    );
    expect(pending.reasonCodes).toContain('ALREADY_PENDING');
  });

  it('withdrawable below the minimum is its own reason', () => {
    const thin = evaluatePayoutEligibility(
      { policy: CORE_50K, balanceMicros: $(50_100), startingBalanceMicros: $(50_000), days: winningDays(5), ...CLEAN },
      1,
    );
    expect(thin.state).toBe('NOT_ELIGIBLE');
    expect(thin.reasonCodes).toContain('INSUFFICIENT_WITHDRAWABLE_PROFIT');
  });
});
