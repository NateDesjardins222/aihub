/**
 * HAPPY TRADER — Portal V2 Account Detail view-model adapter (Product Rebuild
 * Phase 2, STEP 9).
 *
 *   AccountDetailFull (server-authoritative)  →  toAccountDetailView()  →  V2 detail components
 *
 * Like the summary adapter, this RENDERS authoritative truth; it never INVENTS it.
 * It formats/masks/organizes and computes harmless display percentages (profit
 * toward the authoritative target). It decides no eligibility, no pass/fail, no
 * drawdown, and no product economics — those are the server's. Deterministic and
 * pure, so it is fully unit-testable.
 *
 * Rule descriptors come straight from `detail.rules` (the pinned version config,
 * the same numbers the engine enforces). Winning-day and payout-split rows are NOT
 * built here — those are authoritative on the payout eligibility contract and are
 * rendered by the component when that data is present, never fabricated.
 */
import type { AccountDetailFull, PortalRulesView } from '../lib';
import { lifecycleActiveIndex } from './Lifecycle';
import type { StatusKind } from './primitives';
import type { PortalState } from './account-view';
import { evaluationProgress, isTradableForDisplay, productLabel } from './account-view';
import { accountSizeLabel, formatMoney, formatPercent, maskAccountId, moneyTone } from './format';

const STATE_PRESENTATION: Record<PortalState, { kind: StatusKind; label: string }> = {
  PENDING: { kind: 'neutral', label: 'Provisioning' },
  EVALUATION_ACTIVE: { kind: 'evaluation', label: 'Evaluation' },
  EVALUATION_PASSED: { kind: 'funded', label: 'Passed' },
  FUNDED_ACTIVE: { kind: 'funded', label: 'Funded' },
  FAILED: { kind: 'failed', label: 'Breached' },
  COMPLETED_MAX_PAYOUTS: { kind: 'completed', label: 'Completed' },
  INACTIVE_CLOSED: { kind: 'neutral', label: 'Closed' },
  ARCHIVED: { kind: 'neutral', label: 'Archived' },
};

export interface V2Money {
  text: string;
  tone: 'default' | 'positive' | 'negative' | 'muted';
}

export interface V2EvaluationProgressView {
  achievedText: string;
  targetText: string;
  remainingText: string;
  pct: number;
  /** True once the authoritative target has been reached/exceeded (display only). */
  reached: boolean;
}

/** A single authoritative rule row for the Rules tab. */
export interface V2RuleRow {
  key: string;
  label: string;
  value: string;
  sub?: string;
}

export interface V2AccountDetailView {
  // ---- identity / header ----
  id: string;
  publicId: string;
  productLabel: string;
  accountSizeLabel: string;
  nickname: string | null;
  name: string;
  maskedId: string;
  statusKind: StatusKind;
  statusLabel: string;
  portalState: PortalState;
  tradable: boolean;
  lifecycleActiveIndex: number;

  // ---- money (header + overview) ----
  balanceText: string;
  startingBalanceText: string;
  netPnl: V2Money;
  mllRoomText: string;
  mllBreached: boolean;
  realizedPnl: V2Money | null;
  feesText: string | null;

  // ---- evaluation objective (authoritative target) ----
  evaluation: V2EvaluationProgressView | null;

  // ---- rules (authoritative, from the pinned version config) ----
  ruleRows: V2RuleRow[];
  /** True when no authoritative rule config is available for this account. */
  rulesUnavailable: boolean;
}

function humanizeDrawdown(kind: string | null): string {
  switch (kind) {
    case 'EOD_TRAILING': return 'Trailing (end of day)';
    case 'INTRADAY_TRAILING': return 'Trailing (intraday)';
    case 'STATIC': return 'Static';
    default: return kind ?? '';
  }
}

function humanizeConsistency(formula: string | null): string {
  switch (formula) {
    case 'BEST_DAY_OVER_TOTAL': return 'Best day vs. total profit';
    case 'BEST_DAY_OVER_TARGET': return 'Best day vs. target';
    default: return formula ?? '';
  }
}

/** Build the authoritative rule rows from the pinned version config. */
export function ruleRowsFrom(rules: PortalRulesView | null, portalState: PortalState): V2RuleRow[] {
  if (!rules) return [];
  const rows: V2RuleRow[] = [];
  // Profit target — the authoritative objective. Funded accounts have 0 (already
  // passed), so we show "Not applicable" rather than "$0".
  if (rules.profitTargetMicros != null) {
    rows.push(
      rules.profitTargetMicros > 0
        ? { key: 'target', label: 'Profit target', value: formatMoney(rules.profitTargetMicros) }
        : { key: 'target', label: 'Profit target', value: 'Not applicable', sub: portalState === 'FUNDED_ACTIVE' ? 'Funded — already passed' : undefined },
    );
  }
  if (rules.maxLossMicros != null) {
    rows.push({ key: 'maxLoss', label: 'Maximum loss', value: formatMoney(rules.maxLossMicros), sub: humanizeDrawdown(rules.drawdownType) || undefined });
  }
  if (rules.consistencyThreshold != null) {
    rows.push({ key: 'consistency', label: 'Consistency', value: formatPercent(rules.consistencyThreshold), sub: humanizeConsistency(rules.consistencyFormula) || undefined });
  }
  if (rules.maxContracts != null) {
    rows.push({ key: 'contracts', label: 'Max contracts', value: String(rules.maxContracts) });
  }
  if (rules.minWinningDayPnlMicros != null && rules.minWinningDayPnlMicros > 0) {
    rows.push({ key: 'winday', label: 'Winning-day threshold', value: formatMoney(rules.minWinningDayPnlMicros), sub: 'A day counts as winning at or above this' });
  }
  return rows;
}

export function toAccountDetailView(d: AccountDetailFull): V2AccountDetailView {
  const state = d.portalState as PortalState;
  const presentation = STATE_PRESENTATION[state] ?? { kind: 'neutral' as StatusKind, label: state };
  const netPnl = d.balanceMicros - d.startingBalanceMicros;
  const mllRoom = Math.max(0, d.balanceMicros - d.drawdownFloorMicros);

  const prog = evaluationProgress(d);
  const evaluation: V2EvaluationProgressView | null = prog
    ? {
        achievedText: formatMoney(prog.achievedMicros),
        targetText: formatMoney(prog.targetMicros),
        remainingText: formatMoney(prog.remainingMicros),
        pct: prog.pct,
        reached: netPnl >= prog.targetMicros,
      }
    : null;

  const realized = typeof d.realizedPnlMicros === 'number'
    ? { text: formatMoney(d.realizedPnlMicros, { sign: true }), tone: moneyTone(d.realizedPnlMicros) }
    : null;

  return {
    id: d.id,
    publicId: d.publicId,
    productLabel: productLabel(d),
    accountSizeLabel: accountSizeLabel(d.startingBalanceMicros),
    nickname: d.nickname,
    name: d.name,
    maskedId: maskAccountId(d.publicId),
    statusKind: presentation.kind,
    statusLabel: presentation.label,
    portalState: state,
    tradable: isTradableForDisplay(d),
    lifecycleActiveIndex: lifecycleActiveIndex(d.portalState),

    balanceText: formatMoney(d.balanceMicros),
    startingBalanceText: formatMoney(d.startingBalanceMicros),
    netPnl: { text: formatMoney(netPnl, { sign: true }), tone: moneyTone(netPnl) },
    mllRoomText: formatMoney(mllRoom),
    mllBreached: mllRoom <= 0,
    realizedPnl: realized,
    feesText: typeof d.feesMicros === 'number' ? formatMoney(-Math.abs(d.feesMicros), { sign: true }) : null,

    evaluation,

    ruleRows: ruleRowsFrom(d.rules ?? null, state),
    rulesUnavailable: !d.rules,
  };
}
