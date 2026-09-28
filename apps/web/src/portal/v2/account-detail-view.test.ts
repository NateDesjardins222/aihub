/**
 * Portal V2 Account Detail adapter (Product Rebuild Phase 2, STEP 9).
 * Proves the transform is deterministic, renders authoritative rules/target
 * without inventing business truth, is state-aware, and handles boundary money.
 */
import { describe, expect, it } from 'vitest';
import type { AccountDetailFull, PortalRulesView } from '../lib';
import { MICROS_PER_DOLLAR as M } from './format';
import { toAccountDetailView, ruleRowsFrom } from './account-detail-view';
import type { PortalState } from './account-view';

const RULES: PortalRulesView = {
  profitTargetMicros: 6_000 * M, maxLossMicros: 4_000 * M, drawdownType: 'EOD_TRAILING',
  trailingLockAtMicros: 0, consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: 0.5,
  minWinningDays: 0, minWinningDayPnlMicros: 150 * M, maxContracts: 10,
};

function detail(over: Partial<AccountDetailFull> = {}): AccountDetailFull {
  return {
    id: 'a1', publicId: 'HT-1005', name: 'Core 100K', nickname: null,
    accountType: 'EVALUATION', status: 'ACTIVE', portalState: 'EVALUATION_ACTIVE', consumesSlot: true,
    product: { key: 'core-100k', name: 'CORE 100K', version: 3 },
    startingBalanceMicros: 100_000 * M, balanceMicros: 100_000 * M, highWaterMarkMicros: 100_000 * M,
    drawdownFloorMicros: 96_000 * M, profitTargetMicros: 6_000 * M, resetOfAccountId: null,
    archivedAt: null, createdAt: 0,
    realizedPnlMicros: 0, feesMicros: 0, priceMicros: 95 * M, rules: RULES, lifecycles: [],
    ...over,
  };
}

describe('toAccountDetailView — authority & determinism', () => {
  it('is deterministic', () => {
    const d = detail();
    expect(toAccountDetailView(d)).toEqual(toAccountDetailView(d));
  });

  it('renders authoritative header + money (no invention)', () => {
    const v = toAccountDetailView(detail({ balanceMicros: 103_200 * M }));
    expect(v.productLabel).toBe('CORE 100K');
    expect(v.maskedId).toBe('•••• 1005');
    expect(v.balanceText).toBe('$103,200');
    expect(v.startingBalanceText).toBe('$100,000');
    expect(v.netPnl.text).toBe('+$3,200');
    expect(v.netPnl.tone).toBe('positive');
    expect(v.mllRoomText).toBe('$7,200'); // 103,200 − 96,000
    expect(v.statusLabel).toBe('Evaluation');
  });

  it('evaluation progress uses the AUTHORITATIVE target (PV2-1)', () => {
    const v = toAccountDetailView(detail({ balanceMicros: 103_000 * M }));
    expect(v.evaluation).not.toBeNull();
    expect(v.evaluation!.achievedText).toBe('$3,000');
    expect(v.evaluation!.targetText).toBe('$6,000');
    expect(v.evaluation!.remainingText).toBe('$3,000');
    expect(v.evaluation!.pct).toBe(50);
    expect(v.evaluation!.reached).toBe(false);
  });

  it('exact target reached and over-target are truthful (bar clamps, money does not)', () => {
    const at = toAccountDetailView(detail({ balanceMicros: 106_000 * M })).evaluation!;
    expect(at.pct).toBe(100);
    expect(at.reached).toBe(true);
    expect(at.remainingText).toBe('$0');
    const over = toAccountDetailView(detail({ balanceMicros: 108_000 * M })).evaluation!;
    expect(over.pct).toBe(100); // clamped
    expect(over.achievedText).toBe('$8,000'); // NOT clamped — truthful
    expect(over.reached).toBe(true);
  });

  it('negative profit shows 0% and $0 achieved, never negative', () => {
    const v = toAccountDetailView(detail({ balanceMicros: 97_000 * M })).evaluation!;
    expect(v.pct).toBe(0);
    expect(v.achievedText).toBe('$0');
    // Underwater by $3,000 → still needs $9,000 to reach a +$6,000 net target.
    expect(v.remainingText).toBe('$9,000');
  });

  it('funded / terminal accounts show NO evaluation target progress (STEP 4)', () => {
    expect(toAccountDetailView(detail({ portalState: 'FUNDED_ACTIVE', accountType: 'FUNDED_SIM', profitTargetMicros: 0, rules: { ...RULES, profitTargetMicros: 0 } })).evaluation).toBeNull();
    expect(toAccountDetailView(detail({ portalState: 'FAILED', status: 'FAILED' })).evaluation).toBeNull();
    expect(toAccountDetailView(detail({ portalState: 'COMPLETED_MAX_PAYOUTS' })).evaluation).toBeNull();
  });
});

describe('rule rows come from authoritative config only', () => {
  it('maps target / max loss / consistency / contracts / winning-day', () => {
    const rows = ruleRowsFrom(RULES, 'EVALUATION_ACTIVE');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.target!.value).toBe('$6,000');
    expect(byKey.maxLoss!.value).toBe('$4,000');
    expect(byKey.maxLoss!.sub).toBe('Trailing (end of day)');
    expect(byKey.consistency!.value).toBe('50.0%');
    expect(byKey.contracts!.value).toBe('10');
    expect(byKey.winday!.value).toBe('$150');
  });

  it('funded target reads "Not applicable", not "$0"', () => {
    const rows = ruleRowsFrom({ ...RULES, profitTargetMicros: 0 }, 'FUNDED_ACTIVE');
    const target = rows.find((r) => r.key === 'target')!;
    expect(target.value).toBe('Not applicable');
  });

  it('no rules → empty rows and rulesUnavailable flag', () => {
    expect(ruleRowsFrom(null, 'EVALUATION_ACTIVE')).toEqual([]);
    const v = toAccountDetailView(detail({ rules: null }));
    expect(v.rulesUnavailable).toBe(true);
    expect(v.ruleRows).toEqual([]);
  });

  it('degrades individually-missing rule fields without inventing them', () => {
    const partial: PortalRulesView = { ...RULES, consistencyThreshold: null, maxContracts: null };
    const keys = ruleRowsFrom(partial, 'EVALUATION_ACTIVE').map((r) => r.key);
    expect(keys).toContain('target');
    expect(keys).not.toContain('consistency');
    expect(keys).not.toContain('contracts');
  });
});

const ALL_STATES: PortalState[] = [
  'PENDING', 'EVALUATION_ACTIVE', 'EVALUATION_PASSED', 'FUNDED_ACTIVE',
  'FAILED', 'COMPLETED_MAX_PAYOUTS', 'INACTIVE_CLOSED', 'ARCHIVED',
];
describe('every state renders without throwing', () => {
  it('maps a status label + kind for all 8 states', () => {
    for (const s of ALL_STATES) {
      const v = toAccountDetailView(detail({ portalState: s }));
      expect(v.statusLabel, s).toBeTruthy();
      expect(v.portalState, s).toBe(s);
    }
  });
});
