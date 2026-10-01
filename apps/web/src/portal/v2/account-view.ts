/**
 * HAPPY TRADER — Portal V2 account view-model adapter (Product Rebuild Phase 1, STEP 5).
 *
 * The deliberate typed boundary between authoritative domain data and V2 components:
 *
 *     PortalAccountSummary (server-authoritative)  →  toAccountView()  →  V2AccountView  →  V2AccountPanel
 *
 * PRINCIPLE: this layer RENDERS truth, it never INVENTS it. It does not decide pass/
 * fail, payout eligibility, drawdown rules, provisioning, reset rules, or lifecycle
 * transitions — those are the server's (`portalState` is authoritative and is mapped,
 * not recomputed). The only arithmetic here is presentation: subtracting two
 * authoritative micro-dollar figures for a *display* (net P&L = balance − start; MLL
 * room = balance − floor) and formatting. Deterministic and pure, so it is fully
 * unit-testable.
 */
import type { AccountSummary } from '../lib';
import { lifecycleActiveIndex } from './Lifecycle';
import type { StatusKind } from './primitives';
import type { V2AccountView, V2Metric } from './AccountPanel';
import { accountSizeLabel, clampPercent, formatMoney, maskAccountId, moneyTone } from './format';

/** The authoritative portal lifecycle states (mirror of the server `PortalState`). */
export type PortalState =
  | 'PENDING'
  | 'EVALUATION_ACTIVE'
  | 'EVALUATION_PASSED'
  | 'FUNDED_ACTIVE'
  | 'FAILED'
  | 'COMPLETED_MAX_PAYOUTS'
  | 'INACTIVE_CLOSED'
  | 'ARCHIVED';

/** Presentation mapping for each authoritative state. Status colour + label only. */
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

/** Product family from the authoritative product key (never invents a family). */
export function familyOf(productKey: string | null | undefined): string {
  if (!productKey) return '';
  if (productKey.includes('select')) return 'SELECT';
  if (productKey.includes('daily')) return 'DAILY';
  if (productKey.includes('gold')) return 'GOLD';
  return 'CORE';
}

/**
 * Whether the trade action is offered. This is a DISPLAY hint mirroring V1; the
 * authoritative gate is the server handoff route, which re-checks ownership and
 * status. The Portal never grants trading access on its own.
 */
export function isTradableForDisplay(a: Pick<AccountSummary, 'status' | 'accountType'>): boolean {
  return a.status === 'ACTIVE' && (a.accountType === 'EVALUATION' || a.accountType === 'FUNDED_SIM');
}

/** Whether a reset can be offered (display hint; server authorises the actual reset). */
export function isResettableForDisplay(a: Pick<AccountSummary, 'status' | 'accountType'>): boolean {
  return a.status === 'FAILED' && a.accountType === 'EVALUATION';
}

/** Product + size label, e.g. "CORE 100K". Falls back to the authoritative name. */
export function productLabel(a: AccountSummary): string {
  const fam = familyOf(a.product?.key);
  const size = accountSizeLabel(a.startingBalanceMicros);
  const label = `${fam} ${size}`.trim();
  return label || a.product?.name || a.name;
}

/**
 * Optional authoritative extras that do NOT live on AccountSummary (winning days,
 * consistency, payout standing come from PayoutEligibility). When present they
 * enrich a FUNDED account's metrics; when absent those metrics simply do not render
 * — never invented. In production the container passes real eligibility; the dev
 * review passes clearly-labelled dev fixtures.
 */
export interface AccountViewExtra {
  winningDays?: number;
  requiredWinningDays?: number;
  consistencyRatio?: number | null;
  payoutState?: 'ELIGIBLE' | 'NOT_ELIGIBLE';
  availableMicros?: number;
}

/**
 * The one deterministic transform: authoritative fields → a dense, state-aware
 * display model. No business rule is decided here — `portalState` is mapped, money
 * figures are subtracted/formatted for display only.
 */
export function toAccountView(a: AccountSummary, extra?: AccountViewExtra): V2AccountView {
  const state = a.portalState as PortalState;
  const presentation = STATE_PRESENTATION[state] ?? { kind: 'neutral' as StatusKind, label: state };

  const netPnl = a.balanceMicros - a.startingBalanceMicros; // display only
  const mllRoom = Math.max(0, a.balanceMicros - a.drawdownFloorMicros); // display only
  const prog = evaluationProgress(a);

  const m = (label: string, value: string, tone?: V2Metric['tone']): V2Metric => ({ label, value, tone });
  const metrics: V2Metric[] = [];

  if (state === 'EVALUATION_ACTIVE') {
    // The profit-target amount + remaining are carried by the progress bar above, so
    // the metric grid stays non-redundant: standing + risk figures only.
    metrics.push(m('Net P&L', formatMoney(netPnl, { sign: true }), moneyTone(netPnl)));
    metrics.push(m('MLL room', formatMoney(mllRoom)));
    metrics.push(m('Drawdown floor', formatMoney(a.drawdownFloorMicros)));
    metrics.push(m('High-water', formatMoney(a.highWaterMarkMicros)));
  } else if (state === 'FUNDED_ACTIVE') {
    metrics.push(m('Net P&L', formatMoney(netPnl, { sign: true }), moneyTone(netPnl)));
    metrics.push(m('MLL room', formatMoney(mllRoom)));
    metrics.push(m('Drawdown floor', formatMoney(a.drawdownFloorMicros)));
    metrics.push(m('High-water', formatMoney(a.highWaterMarkMicros)));
    if (extra?.winningDays != null) {
      const req = extra.requiredWinningDays;
      metrics.push(m('Winning days', req != null ? `${extra.winningDays} / ${req}` : String(extra.winningDays)));
    }
    if (extra?.consistencyRatio != null) metrics.push(m('Consistency', `${Math.round(extra.consistencyRatio * 100)}%`));
    if (extra?.availableMicros != null) metrics.push(m('Payout available', formatMoney(extra.availableMicros), extra.availableMicros > 0 ? 'positive' : 'muted'));
  } else if (state === 'EVALUATION_PASSED') {
    metrics.push(m('Net P&L', formatMoney(netPnl, { sign: true }), moneyTone(netPnl)));
    metrics.push(m('MLL room', formatMoney(mllRoom)));
    metrics.push(m('Drawdown floor', formatMoney(a.drawdownFloorMicros)));
  } else if (state === 'FAILED') {
    metrics.push(m('Final balance', formatMoney(a.balanceMicros)));
    metrics.push(m('Net P&L', formatMoney(netPnl, { sign: true }), moneyTone(netPnl)));
    metrics.push(m('Breach floor', formatMoney(a.drawdownFloorMicros)));
  } else if (state === 'COMPLETED_MAX_PAYOUTS') {
    metrics.push(m('Final balance', formatMoney(a.balanceMicros)));
    metrics.push(m('Net P&L', formatMoney(netPnl, { sign: true }), moneyTone(netPnl)));
  } else {
    metrics.push(m('Balance', formatMoney(a.balanceMicros)));
  }

  return {
    productLabel: productLabel(a),
    maskedId: maskAccountId(a.publicId),
    accountKind: a.accountType === 'FUNDED_SIM' ? 'Funded' : 'Evaluation',
    statusKind: presentation.kind,
    statusLabel: presentation.label,
    portalState: state,
    balanceText: formatMoney(a.balanceMicros),
    metrics,
    progressLabel: prog ? 'Profit target' : undefined,
    progressPct: prog?.pct,
    progressDetail: prog ? `${formatMoney(prog.achievedMicros)} of ${formatMoney(prog.targetMicros)}` : undefined,
    tradable: isTradableForDisplay(a),
  };
}

/** Authoritative evaluation profit-target progress, or null when not applicable. */
export interface EvaluationProgress {
  /** Profit achieved toward the target, floored at 0 (never negative). Micro-dollars. */
  achievedMicros: number;
  /** The authoritative profit target. Micro-dollars. */
  targetMicros: number;
  /** Amount still needed to reach the target, floored at 0. Micro-dollars. */
  remainingMicros: number;
  /** Visual progress percentage, clamped 0..100. The money above is NOT clamped. */
  pct: number;
}

/**
 * Compute profit-target progress for a LIVE evaluation account. Returns null for
 * any account that should not show a target bar (funded, terminal, or no
 * authoritative target). Pure display arithmetic over authoritative figures — it
 * decides no business outcome; PASS remains the server's.
 */
export function evaluationProgress(
  a: Pick<AccountSummary, 'portalState' | 'balanceMicros' | 'startingBalanceMicros' | 'profitTargetMicros'>,
): EvaluationProgress | null {
  if (a.portalState !== 'EVALUATION_ACTIVE') return null;
  const target = a.profitTargetMicros;
  if (typeof target !== 'number' || target <= 0) return null;
  const netPnl = a.balanceMicros - a.startingBalanceMicros;
  const achievedMicros = Math.max(0, netPnl); // progress cannot be negative
  const remainingMicros = Math.max(0, target - netPnl);
  const pct = clampPercent((netPnl / target) * 100); // bar clamps; money above does not
  return { achievedMicros, targetMicros: target, remainingMicros, pct };
}

/** Highest reached lifecycle stage for an account (re-exported for callers/tests). */
export function accountLifecycleIndex(a: Pick<AccountSummary, 'portalState'>): number {
  return lifecycleActiveIndex(a.portalState);
}
