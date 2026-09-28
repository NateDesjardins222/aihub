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
import type { V2AccountView } from './AccountPanel';
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
 * The one deterministic transform. Everything here is a display of authoritative
 * fields — no business rule is decided.
 */
export function toAccountView(a: AccountSummary): V2AccountView {
  const state = a.portalState as PortalState;
  const presentation = STATE_PRESENTATION[state] ?? { kind: 'neutral' as StatusKind, label: state };

  const netPnl = a.balanceMicros - a.startingBalanceMicros; // display only
  const mllRoom = Math.max(0, a.balanceMicros - a.drawdownFloorMicros); // display only

  // State-aware progress (PV2-1, Phase 2). For a LIVE EVALUATION the primary
  // progress is profit toward the AUTHORITATIVE profit target (from the pinned
  // version config; the same number the engine passes on). It is never inferred
  // from account size or product name. A funded/terminal account shows no target
  // bar — a funded account has already passed, so there is no evaluation target to
  // progress toward (its authoritative target is 0). Risk room is shown separately
  // via mllRoomText.
  const prog = evaluationProgress(a);

  return {
    productLabel: productLabel(a),
    maskedId: maskAccountId(a.publicId),
    statusKind: presentation.kind,
    statusLabel: presentation.label,
    portalState: state,
    balanceText: formatMoney(a.balanceMicros),
    netPnlText: formatMoney(netPnl, { sign: true }),
    netPnlTone: moneyTone(netPnl),
    mllRoomText: formatMoney(mllRoom),
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
