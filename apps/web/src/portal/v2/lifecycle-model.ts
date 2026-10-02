/**
 * HAPPY TRADER — the ONE deterministic customer lifecycle view model + Next Up engine.
 *
 * Customer Golden Path Phase 1 (WEB-2). Before this module, "where am I / what's next"
 * was re-derived independently in dashboard.tsx, AccountsView.tsx and account-view.ts,
 * and they diverged. This is the single source every customer surface reads.
 *
 * PRINCIPLE (same as account-view.ts): this layer PRESENTS authoritative truth; it never
 * INVENTS a business rule. It maps the server's `portalState` (never recomputes pass/fail),
 * and it reads eligibility / winning-days / lifetime-paid that the server computed. The
 * only arithmetic is presentation (a progress ratio, a count, picking the single most
 * important action). It is pure and deterministic — no Date.now, no randomness, no I/O —
 * so it is fully unit-testable and renders identically for identical inputs.
 *
 * LANGUAGE: every string here is truthful and restrained. It never urges trading, never
 * manufactures urgency, never celebrates frequency or loss-recovery. It states where the
 * customer is and what they can do.
 */
import type { AccountSummary } from '../lib';
import type { AccountViewExtra } from './account-view';
import type { PortalState } from './account-view';

/** The customer's overall lifecycle phase — their single current position. */
export type LifecyclePhase =
  | 'ONBOARDING'
  | 'EVALUATION'
  | 'QUALIFIED'
  | 'FUNDED'
  | 'PAYOUT_READY'
  | 'ESTABLISHED'
  | 'DORMANT';

export type NextUpKind =
  | 'GET_STARTED'
  | 'PROVISIONING'
  | 'EVALUATION_PROGRESS'
  | 'FUNDING_IN_PROGRESS'
  | 'FUNDED_PROGRESS'
  | 'REQUEST_PAYOUT'
  | 'VIEW_PROGRESS';

export type NextUpTone = 'action' | 'progress' | 'info';
export type NextUpTarget = 'account' | 'payouts' | 'add-account' | 'progress';

export interface NextUpAction {
  kind: NextUpKind;
  tone: NextUpTone;
  /** Short, declarative, non-manipulative. */
  title: string;
  /** One truthful line of context. */
  detail: string;
  cta: { label: string; target: NextUpTarget };
  /** The account this concerns, when it concerns one. */
  accountId?: string;
  /** Presentation progress ratio 0..1, when the action has measurable progress. */
  progress?: number;
  /** Deterministic ranking weight (higher = more important). Exposed for tests/debug. */
  priority: number;
}

export interface LifecycleCounts {
  pending: number;
  evaluationsActive: number;
  passed: number;
  funded: number;
  breached: number;
  completed: number;
  /** Accounts consuming an active slot (the authoritative `consumesSlot`). */
  active: number;
}

export interface LifecycleAccomplishments {
  lifetimePaidMicros: number;
  achievementsEarned: number;
  currentClub: 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB' | null;
}

export interface LifecycleView {
  phase: LifecyclePhase;
  phaseLabel: string;
  phaseSummary: string;
  counts: LifecycleCounts;
  /** The single most important next action, or null when there is nothing to surface. */
  nextUp: NextUpAction | null;
  /** All forward-progress actions, ranked (nextUp is queue[0]). */
  queue: NextUpAction[];
  accomplishments: LifecycleAccomplishments;
}

export interface LifecycleInput {
  accounts: AccountSummary[];
  extraFor: (a: AccountSummary) => AccountViewExtra | undefined;
  progress: {
    lifetimePaidTraderShareMicros: number;
    achievementsEarned: number;
    currentClub: 'TENK_CLUB' | 'FIFTYK_CLUB' | 'HUNDREDK_CLUB' | null;
  };
}

/** Priority weights — the deterministic ordering of what matters most to surface. */
const PRIORITY: Record<NextUpKind, number> = {
  REQUEST_PAYOUT: 100,
  FUNDING_IN_PROGRESS: 85,
  PROVISIONING: 70,
  FUNDED_PROGRESS: 60,
  EVALUATION_PROGRESS: 55,
  GET_STARTED: 40,
  VIEW_PROGRESS: 30,
};

function stateOf(a: AccountSummary): PortalState {
  return a.portalState as PortalState;
}

function isEligibleFunded(extra: AccountViewExtra | undefined): boolean {
  if (!extra) return false;
  return (extra.availableMicros ?? 0) > 0 || extra.payoutState === 'ELIGIBLE';
}

/** Profit-target progress ratio for a live evaluation, 0..1 (display only). */
function evalProgressRatio(a: AccountSummary): number {
  const target = a.profitTargetMicros;
  if (typeof target !== 'number' || target <= 0) return 0;
  const net = a.balanceMicros - a.startingBalanceMicros;
  return clamp01(net / target);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Build the single forward-progress action for one account, or null if it has none. */
function candidateFor(a: AccountSummary, extra: AccountViewExtra | undefined): NextUpAction | null {
  const state = stateOf(a);
  switch (state) {
    case 'PENDING':
      return {
        kind: 'PROVISIONING',
        tone: 'info',
        title: 'Your account is being set up',
        detail: 'This usually takes just a moment. You can trade as soon as it is ready.',
        cta: { label: 'View account', target: 'account' },
        accountId: a.id,
        priority: PRIORITY.PROVISIONING,
      };
    case 'EVALUATION_PASSED':
      return {
        kind: 'FUNDING_IN_PROGRESS',
        tone: 'info',
        title: 'Evaluation passed — activating your funded account',
        detail: 'Your funded account is being created. You will be notified when it is ready.',
        cta: { label: 'View account', target: 'account' },
        accountId: a.id,
        priority: PRIORITY.FUNDING_IN_PROGRESS,
      };
    case 'FUNDED_ACTIVE': {
      if (isEligibleFunded(extra)) {
        const avail = extra?.availableMicros ?? 0;
        return {
          kind: 'REQUEST_PAYOUT',
          tone: 'action',
          title: 'Request your payout',
          detail: avail > 0 ? 'You have funds available to withdraw.' : 'This account is eligible for a payout.',
          cta: { label: 'Go to payouts', target: 'payouts' },
          accountId: a.id,
          priority: PRIORITY.REQUEST_PAYOUT,
        };
      }
      const wd = extra?.winningDays;
      const req = extra?.requiredWinningDays;
      const ratio = wd != null && req != null && req > 0 ? clamp01(wd / req) : undefined;
      return {
        kind: 'FUNDED_PROGRESS',
        tone: 'progress',
        title: 'Building toward your next payout',
        detail: wd != null && req != null
          ? `${wd} of ${req} winning days so far.`
          : 'Your funded account is active.',
        cta: { label: 'View account', target: 'account' },
        accountId: a.id,
        progress: ratio,
        priority: PRIORITY.FUNDED_PROGRESS,
      };
    }
    case 'EVALUATION_ACTIVE':
      return {
        kind: 'EVALUATION_PROGRESS',
        tone: 'progress',
        title: 'Continue your evaluation',
        detail: evaluationDetail(a),
        cta: { label: 'View account', target: 'account' },
        accountId: a.id,
        progress: evalProgressRatio(a),
        priority: PRIORITY.EVALUATION_PROGRESS,
      };
    default:
      // FAILED / COMPLETED_MAX_PAYOUTS / INACTIVE_CLOSED / ARCHIVED: no forward action
      // here. Breaches have their own dashboard banner; terminal accounts live in history.
      return null;
  }
}

function evaluationDetail(a: AccountSummary): string {
  const target = a.profitTargetMicros;
  if (typeof target !== 'number' || target <= 0) return 'Trade toward your profit target.';
  const net = a.balanceMicros - a.startingBalanceMicros;
  const remaining = Math.max(0, target - net);
  return remaining <= 0
    ? 'You have reached your profit target.'
    : `${formatUsd(Math.max(0, net))} of ${formatUsd(target)} profit target reached.`;
}

/** Compact whole-dollar formatting for lifecycle copy (micro-dollars → "$1,234"). */
function formatUsd(micros: number): string {
  const dollars = Math.round(micros / 1_000_000);
  return `$${dollars.toLocaleString('en-US')}`;
}

/**
 * The one deterministic transform: authoritative accounts + extras + progress → the
 * customer's lifecycle view, including the single most important next action.
 */
export function buildLifecycleView(input: LifecycleInput): LifecycleView {
  const { accounts, extraFor, progress } = input;

  const counts: LifecycleCounts = {
    pending: 0, evaluationsActive: 0, passed: 0, funded: 0, breached: 0, completed: 0, active: 0,
  };
  for (const a of accounts) {
    if (a.consumesSlot) counts.active += 1;
    switch (stateOf(a)) {
      case 'PENDING': counts.pending += 1; break;
      case 'EVALUATION_ACTIVE': counts.evaluationsActive += 1; break;
      case 'EVALUATION_PASSED': counts.passed += 1; break;
      case 'FUNDED_ACTIVE': counts.funded += 1; break;
      case 'FAILED': counts.breached += 1; break;
      case 'COMPLETED_MAX_PAYOUTS': counts.completed += 1; break;
      default: break;
    }
  }

  // Build and rank candidate actions deterministically.
  const candidates: Array<{ action: NextUpAction; createdAt: number; id: string }> = [];
  for (const a of accounts) {
    const action = candidateFor(a, extraFor(a));
    if (action) candidates.push({ action, createdAt: a.createdAt, id: a.id });
  }
  candidates.sort((x, y) =>
    y.action.priority - x.action.priority || x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  const queue: NextUpAction[] = candidates.map((c) => c.action);

  const accomplishments: LifecycleAccomplishments = {
    lifetimePaidMicros: progress.lifetimePaidTraderShareMicros,
    achievementsEarned: progress.achievementsEarned,
    currentClub: progress.currentClub,
  };
  const hasAccomplishments = accomplishments.lifetimePaidMicros > 0 || accomplishments.achievementsEarned > 0;

  // If nothing is in flight, surface the right standing action.
  let nextUp: NextUpAction | null = queue[0] ?? null;
  if (queue.length === 0) {
    const hasAnyAccount = accounts.length > 0;
    if (!hasAnyAccount) {
      nextUp = getStartedAction();
    } else if (hasAccomplishments || counts.completed > 0) {
      nextUp = viewProgressAction();
    } else {
      // Only terminal accounts, nothing accomplished — offer a fresh start without pressure.
      nextUp = getStartedAction();
    }
  }

  const phase = derivePhase(counts, queue, hasAccomplishments);
  const { phaseLabel, phaseSummary } = describePhase(phase, counts, accomplishments);

  return { phase, phaseLabel, phaseSummary, counts, nextUp, queue, accomplishments };
}

function getStartedAction(): NextUpAction {
  return {
    kind: 'GET_STARTED',
    tone: 'action',
    title: 'Start your evaluation',
    detail: 'Buy an evaluation to begin your path to a funded account.',
    cta: { label: 'Add account', target: 'add-account' },
    priority: PRIORITY.GET_STARTED,
  };
}

function viewProgressAction(): NextUpAction {
  return {
    kind: 'VIEW_PROGRESS',
    tone: 'info',
    title: 'Review your journey',
    detail: 'See what you have accomplished and the clubs you have reached.',
    cta: { label: 'Open journey', target: 'progress' },
    priority: PRIORITY.VIEW_PROGRESS,
  };
}

function derivePhase(counts: LifecycleCounts, queue: NextUpAction[], hasAccomplishments: boolean): LifecyclePhase {
  const hasEligiblePayout = queue.some((q) => q.kind === 'REQUEST_PAYOUT');
  if (hasEligiblePayout) return 'PAYOUT_READY';
  if (counts.funded > 0) return 'FUNDED';
  if (counts.passed > 0) return 'QUALIFIED';
  if (counts.evaluationsActive > 0 || counts.pending > 0) return 'EVALUATION';
  if (hasAccomplishments || counts.completed > 0) return 'ESTABLISHED';
  if (counts.breached > 0) return 'DORMANT';
  return 'ONBOARDING';
}

function describePhase(
  phase: LifecyclePhase,
  counts: LifecycleCounts,
  acc: LifecycleAccomplishments,
): { phaseLabel: string; phaseSummary: string } {
  switch (phase) {
    case 'PAYOUT_READY':
      return { phaseLabel: 'Payout ready', phaseSummary: 'A funded account is eligible for a payout.' };
    case 'FUNDED':
      return {
        phaseLabel: 'Funded trader',
        phaseSummary: plural(counts.funded, 'funded account') + ' active.',
      };
    case 'QUALIFIED':
      return { phaseLabel: 'Evaluation passed', phaseSummary: 'Your funded account is being activated.' };
    case 'EVALUATION':
      return {
        phaseLabel: 'In evaluation',
        phaseSummary: counts.evaluationsActive > 0
          ? plural(counts.evaluationsActive, 'evaluation') + ' in progress.'
          : 'Your account is being set up.',
      };
    case 'ESTABLISHED':
      return {
        phaseLabel: 'Established trader',
        phaseSummary: acc.lifetimePaidMicros > 0
          ? `${formatUsd(acc.lifetimePaidMicros)} paid to you, lifetime.`
          : 'Your trading history is in your account.',
      };
    case 'DORMANT':
      return {
        phaseLabel: 'Welcome back',
        phaseSummary: 'Your past accounts are in your history. Start a new evaluation when you are ready.',
      };
    case 'ONBOARDING':
    default:
      return { phaseLabel: 'Getting started', phaseSummary: 'Buy an evaluation to begin.' };
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
