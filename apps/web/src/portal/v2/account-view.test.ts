/**
 * Portal V2 account view-model adapter (Product Rebuild Phase 1, STEP 5/6).
 * Proves the transform is deterministic, renders authoritative state without
 * inventing business truth, covers all 8 portal states, and handles boundary money.
 */
import { describe, expect, it } from 'vitest';
import type { AccountSummary } from '../lib';
import { MICROS_PER_DOLLAR as M } from './format';
import {
  toAccountView, productLabel, isTradableForDisplay, isResettableForDisplay, accountLifecycleIndex,
  type PortalState,
} from './account-view';

function acct(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 'a1', publicId: 'HT-1005', name: 'Core 100K', nickname: null,
    accountType: 'EVALUATION', status: 'ACTIVE', portalState: 'EVALUATION_ACTIVE', consumesSlot: true,
    product: { key: 'core-100k', name: 'CORE 100K', version: 3 },
    startingBalanceMicros: 100_000 * M, balanceMicros: 100_000 * M, highWaterMarkMicros: 100_000 * M,
    drawdownFloorMicros: 96_000 * M, profitTargetMicros: 6_000 * M, resetOfAccountId: null, archivedAt: null, createdAt: 0,
    ...over,
  };
}

const ALL_STATES: PortalState[] = [
  'PENDING', 'EVALUATION_ACTIVE', 'EVALUATION_PASSED', 'FUNDED_ACTIVE',
  'FAILED', 'COMPLETED_MAX_PAYOUTS', 'INACTIVE_CLOSED', 'ARCHIVED',
];

describe('toAccountView — determinism & authority', () => {
  it('is deterministic (same input → identical output)', () => {
    const a = acct();
    expect(toAccountView(a)).toEqual(toAccountView(a));
  });

  it('renders every authoritative portal state with a status + never throws', () => {
    for (const s of ALL_STATES) {
      const v = toAccountView(acct({ portalState: s }));
      expect(v.statusLabel, s).toBeTruthy();
      expect(v.statusKind, s).toBeTruthy();
      expect(v.portalState, s).toBe(s);
    }
  });

  it('maps state → lifecycle index from the authoritative state, not a recomputation', () => {
    expect(accountLifecycleIndex(acct({ portalState: 'EVALUATION_ACTIVE' }))).toBe(0);
    expect(accountLifecycleIndex(acct({ portalState: 'FUNDED_ACTIVE' }))).toBe(1);
    expect(accountLifecycleIndex(acct({ portalState: 'COMPLETED_MAX_PAYOUTS' }))).toBe(3);
    expect(accountLifecycleIndex(acct({ portalState: 'FAILED' }))).toBe(-1);
  });

  it('net P&L is a pure display of balance − start (no rule invention)', () => {
    const up = toAccountView(acct({ balanceMicros: 102_480 * M }));
    expect(up.netPnlText).toBe('+$2,480');
    expect(up.netPnlTone).toBe('positive');
    const down = toAccountView(acct({ balanceMicros: 95_900 * M }));
    expect(down.netPnlText).toBe('-$4,100');
    expect(down.netPnlTone).toBe('negative');
    const flat = toAccountView(acct());
    expect(flat.netPnlText).toBe('$0');
    expect(flat.netPnlTone).toBe('muted');
  });

  it('MLL room is balance − floor, floored at zero', () => {
    expect(toAccountView(acct()).mllRoomText).toBe('$4,000');
    expect(toAccountView(acct({ balanceMicros: 95_000 * M })).mllRoomText).toBe('$0'); // below floor
  });

  it('shows AUTHORITATIVE profit-target progress for a live evaluation, clamped 0..100 (PV2-1)', () => {
    // Start = 100k, target = 6k. Net profit toward the authoritative target.
    expect(toAccountView(acct()).progressLabel).toBe('Profit target'); // 0% at start
    expect(toAccountView(acct()).progressPct).toBe(0);
    expect(toAccountView(acct({ balanceMicros: 103_000 * M })).progressPct).toBe(50); // +$3k / $6k
    expect(toAccountView(acct({ balanceMicros: 106_000 * M })).progressPct).toBe(100); // target reached
    // Over target → bar clamps to 100, but the displayed money is not clamped.
    const over = toAccountView(acct({ balanceMicros: 108_000 * M }));
    expect(over.progressPct).toBe(100);
    expect(over.progressDetail).toBe('$8,000 of $6,000');
    // Below start → 0, never negative.
    expect(toAccountView(acct({ balanceMicros: 95_000 * M })).progressPct).toBe(0);
    expect(toAccountView(acct({ balanceMicros: 95_000 * M })).progressDetail).toBe('$0 of $6,000');
  });

  it('does NOT show evaluation target progress for funded/terminal/no-target accounts (PV2-1, STEP 4)', () => {
    // Funded: authoritative target is 0 → no evaluation bar (not "still trying to pass").
    const funded = toAccountView(acct({ portalState: 'FUNDED_ACTIVE', accountType: 'FUNDED_SIM', profitTargetMicros: 0 }));
    expect(funded.progressPct).toBeUndefined();
    expect(funded.progressLabel).toBeUndefined();
    // Terminal states never show a bar.
    expect(toAccountView(acct({ portalState: 'FAILED', status: 'FAILED' })).progressPct).toBeUndefined();
    expect(toAccountView(acct({ portalState: 'COMPLETED_MAX_PAYOUTS' })).progressPct).toBeUndefined();
    // No authoritative target (null config) → no bar (never inferred from size/name).
    expect(toAccountView(acct({ profitTargetMicros: null })).progressPct).toBeUndefined();
    expect(toAccountView(acct({ profitTargetMicros: 0 })).progressPct).toBeUndefined();
  });

  it('builds a product + size label and masked id', () => {
    const v = toAccountView(acct());
    expect(v.productLabel).toBe('CORE 100K');
    expect(v.maskedId).toBe('•••• 1005');
    expect(productLabel(acct({ product: { key: 'select-50k', name: 'x', version: 1 }, startingBalanceMicros: 50_000 * M })))
      .toBe('SELECT 50K');
  });

  it('does not fabricate a family when the product is missing (size still shown)', () => {
    // No product key → no family, but the size is still authoritative from the
    // starting balance, so the label is the size alone — nothing invented.
    expect(toAccountView(acct({ product: null })).productLabel).toBe('100K');
    // With neither product nor a derivable size, fall back to the authoritative name.
    expect(toAccountView(acct({ product: null, startingBalanceMicros: 0, name: 'Legacy Account' })).productLabel)
      .toBe('Legacy Account');
  });
});

describe('display action gates mirror V1 (server remains authoritative)', () => {
  it('tradable only for ACTIVE eval / funded-sim', () => {
    expect(isTradableForDisplay({ status: 'ACTIVE', accountType: 'EVALUATION' })).toBe(true);
    expect(isTradableForDisplay({ status: 'ACTIVE', accountType: 'FUNDED_SIM' })).toBe(true);
    expect(isTradableForDisplay({ status: 'FAILED', accountType: 'EVALUATION' })).toBe(false);
    expect(isTradableForDisplay({ status: 'ACTIVE', accountType: 'TERMINAL' })).toBe(false);
  });
  it('resettable only for a failed evaluation', () => {
    expect(isResettableForDisplay({ status: 'FAILED', accountType: 'EVALUATION' })).toBe(true);
    expect(isResettableForDisplay({ status: 'ACTIVE', accountType: 'EVALUATION' })).toBe(false);
    expect(isResettableForDisplay({ status: 'FAILED', accountType: 'FUNDED_SIM' })).toBe(false);
  });
});
