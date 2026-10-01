/**
 * Portal V2 — DEVELOPMENT-ONLY fixtures (Product Rebuild Phase 1, STEP 17).
 *
 * Representative account-state combinations so engineers (and Nathan) can exercise
 * every V2 account state in the dev harness WITHOUT a session or real data. These
 * are unmistakably development values and are imported ONLY by the dev harness
 * (reached at /portal-v2 in dev builds); no production code path imports this file.
 * Nothing here is ever shown to a customer as truth.
 */
import type { AccountDetailFull, AccountSummary, AccountsView, PortalRulesView } from '../lib';
import { MICROS_PER_DOLLAR as M } from './format';

function fx(over: Partial<AccountSummary> & { id: string; publicId: string }): AccountSummary {
  return {
    name: 'DEV Account', nickname: null, accountType: 'EVALUATION', status: 'ACTIVE',
    portalState: 'EVALUATION_ACTIVE', consumesSlot: true,
    product: { key: 'core-100k', name: 'CORE 100K', version: 3 },
    startingBalanceMicros: 100_000 * M, balanceMicros: 100_000 * M, highWaterMarkMicros: 100_000 * M,
    drawdownFloorMicros: 96_000 * M, profitTargetMicros: 6_000 * M, resetOfAccountId: null, archivedAt: null, createdAt: 0,
    ...over,
  };
}

/** One fixture per supported account state (see PORTAL_V2_ACCOUNT_STATE_MATRIX.md). */
export const FIXTURE_ACCOUNTS: Record<string, AccountSummary> = {
  provisioning: fx({ id: 'f-pending', publicId: 'DEV-0001', portalState: 'PENDING', status: 'PENDING' }),
  evaluationActive: fx({ id: 'f-eval', publicId: 'DEV-1005', portalState: 'EVALUATION_ACTIVE', balanceMicros: 103_200 * M }),
  evaluationPassed: fx({ id: 'f-passed', publicId: 'DEV-1010', portalState: 'EVALUATION_PASSED', status: 'EVALUATION_PASSED', balanceMicros: 106_000 * M }),
  fundedActive: fx({ id: 'f-funded', publicId: 'DEV-2213', accountType: 'FUNDED_SIM', portalState: 'FUNDED_ACTIVE', product: { key: 'core-50k', name: 'CORE 50K', version: 3 }, startingBalanceMicros: 50_000 * M, balanceMicros: 52_480 * M, drawdownFloorMicros: 48_000 * M, profitTargetMicros: 0 }),
  breached: fx({ id: 'f-failed', publicId: 'DEV-7788', portalState: 'FAILED', status: 'FAILED', balanceMicros: 95_900 * M, product: { key: 'select-100k', name: 'SELECT 100K', version: 2 } }),
  completed: fx({ id: 'f-done', publicId: 'DEV-3050', accountType: 'FUNDED_SIM', portalState: 'COMPLETED_MAX_PAYOUTS', status: 'COMPLETED', balanceMicros: 118_400 * M, profitTargetMicros: 0 }),
  closed: fx({ id: 'f-closed', publicId: 'DEV-4001', portalState: 'INACTIVE_CLOSED', status: 'INACTIVE' }),
  archived: fx({ id: 'f-arch', publicId: 'DEV-4099', portalState: 'ARCHIVED', archivedAt: 1_700_000_000_000 }),
  // Boundary money: exactly at floor, huge balance, long id.
  atFloor: fx({ id: 'f-floor', publicId: 'DEV-9000', balanceMicros: 96_000 * M }),
  large: fx({ id: 'f-large', publicId: 'DEV-HUGE-000123456789', portalState: 'FUNDED_ACTIVE', accountType: 'FUNDED_SIM', startingBalanceMicros: 150_000 * M, balanceMicros: 1_284_500 * M, drawdownFloorMicros: 144_000 * M, profitTargetMicros: 0 }),
};

export const FIXTURE_VIEW: AccountsView = {
  accounts: [
    FIXTURE_ACCOUNTS.evaluationActive!,
    FIXTURE_ACCOUNTS.fundedActive!,
    FIXTURE_ACCOUNTS.breached!,
    FIXTURE_ACCOUNTS.completed!,
  ],
  activeSlotsUsed: 2,
  maxActiveSlots: 5,
};

export const FIXTURE_VIEW_EMPTY: AccountsView = { accounts: [], activeSlotsUsed: 0, maxActiveSlots: 5 };

/**
 * A deterministically LONG accounts view for the dev review environment and the
 * scroll regression: every fixture account state, so the page provably exceeds the
 * viewport at review widths and vertical scrolling can be verified end to end.
 */
export const FIXTURE_VIEW_LONG: AccountsView = {
  accounts: [
    FIXTURE_ACCOUNTS.evaluationActive!, FIXTURE_ACCOUNTS.fundedActive!, FIXTURE_ACCOUNTS.evaluationPassed!,
    FIXTURE_ACCOUNTS.breached!, FIXTURE_ACCOUNTS.completed!, FIXTURE_ACCOUNTS.provisioning!,
    FIXTURE_ACCOUNTS.atFloor!, FIXTURE_ACCOUNTS.large!, FIXTURE_ACCOUNTS.closed!, FIXTURE_ACCOUNTS.archived!,
  ],
  activeSlotsUsed: 4,
  maxActiveSlots: 5,
};

// ---- Account-detail fixtures (dev harness only) ----------------------------
const EVAL_RULES: PortalRulesView = {
  profitTargetMicros: 6_000 * M, maxLossMicros: 4_000 * M, drawdownType: 'EOD_TRAILING',
  trailingLockAtMicros: 0, consistencyFormula: 'BEST_DAY_OVER_TOTAL', consistencyThreshold: 0.5,
  minWinningDays: 0, minWinningDayPnlMicros: 150 * M, maxContracts: 10,
};
const FUNDED_RULES: PortalRulesView = { ...EVAL_RULES, profitTargetMicros: 0, maxLossMicros: 2_000 * M, maxContracts: 5, consistencyThreshold: 0.4 };

function detail(summary: AccountSummary, over: Partial<AccountDetailFull> = {}): AccountDetailFull {
  return {
    ...summary,
    realizedPnlMicros: summary.balanceMicros - summary.startingBalanceMicros,
    feesMicros: 240 * M,
    priceMicros: 95 * M,
    rules: EVAL_RULES,
    lifecycles: [{ seq: 1, startedAt: 1_700_000_000_000, endedAt: null, endReason: null, finalStatus: null, startingBalanceMicros: summary.startingBalanceMicros }],
    ...over,
  };
}

/**
 * Resolve a detail fixture for any summary: the richer hand-authored detail when
 * one exists for this account id, otherwise a derived detail from the summary — so
 * every account card in the dev review can open to a real V2 Account Detail view.
 */
export function fixtureDetailFor(summary: AccountSummary): AccountDetailFull {
  const known = Object.values(FIXTURE_DETAILS).find((d) => d.id === summary.id);
  return known ?? detail(summary);
}

/** One detail per major state, mapped through the real adapter in the harness. */
export const FIXTURE_DETAILS: Record<string, AccountDetailFull> = {
  evaluationActive: detail(FIXTURE_ACCOUNTS.evaluationActive!),
  fundedActive: detail(FIXTURE_ACCOUNTS.fundedActive!, { rules: FUNDED_RULES, feesMicros: 1_120 * M }),
  breached: detail(FIXTURE_ACCOUNTS.breached!, {
    rules: { ...EVAL_RULES, profitTargetMicros: 6_000 * M, maxLossMicros: 4_000 * M },
    lifecycles: [{ seq: 1, startedAt: 1_699_000_000_000, endedAt: 1_700_500_000_000, endReason: 'BREACH', finalStatus: 'FAILED', startingBalanceMicros: 100_000 * M }],
  }),
  completed: detail(FIXTURE_ACCOUNTS.completed!, { rules: FUNDED_RULES }),
  large: detail(FIXTURE_ACCOUNTS.large!, { rules: FUNDED_RULES }),
};

// ---- Rebuild (human-rejection #1): funded extras + destination-page fixtures ----
// Dev-only. In production these come from authoritative endpoints (payout
// eligibility, certificates, commerce orders, support tickets); the dev review
// supplies representative values so every customer destination is navigable.
import type { AccountViewExtra } from './account-view';
import type { ActivityItem } from './primitives';
import type { Cert } from '../lib';
import type { PayoutsView, BillingView, SupportView } from './pages';

const DAY = 86_400_000;
const now = Date.now();

/** Authoritative funded-only extras (winning days / consistency / payout) by id. */
export const FIXTURE_FUNDED_EXTRA: Record<string, AccountViewExtra> = {
  'f-funded': { winningDays: 4, requiredWinningDays: 5, consistencyRatio: 0.38, payoutState: 'NOT_ELIGIBLE', availableMicros: 0 },
  'f-large': { winningDays: 8, requiredWinningDays: 5, consistencyRatio: 0.41, payoutState: 'ELIGIBLE', availableMicros: 2_000 * M },
  'f-done': { winningDays: 12, requiredWinningDays: 5, consistencyRatio: 0.33 },
};

export const FIXTURE_PAYOUTS: PayoutsView = {
  totalPaidMicros: 8_600 * M,
  availableMicros: 2_000 * M,
  inReviewMicros: 1_250 * M,
  cyclesText: '3 of 12',
  standing: [
    { accountId: 'f-large', accountLabel: 'CORE 150K · •••• 6789', eligible: true, availableMicros: 2_000 * M, winningDays: '8 / 5' },
    { accountId: 'f-funded', accountLabel: 'CORE 50K · •••• 2213', eligible: false, availableMicros: 0, winningDays: '4 / 5' },
  ],
  history: [
    { id: 'p1', dateMs: now - 6 * DAY, accountLabel: 'CORE 150K · •••• 6789', grossMicros: 2_500 * M, traderMicros: 2_250 * M, state: 'PAID' },
    { id: 'p2', dateMs: now - 20 * DAY, accountLabel: 'CORE 150K · •••• 6789', grossMicros: 1_800 * M, traderMicros: 1_620 * M, state: 'PAID' },
    { id: 'p3', dateMs: now - 2 * DAY, accountLabel: 'CORE 150K · •••• 6789', grossMicros: 1_250 * M, traderMicros: 1_125 * M, state: 'UNDER_REVIEW' },
  ],
};

export const FIXTURE_CERTS: Cert[] = [
  { id: 'c1', certificatePublicId: 'HT-FT-10294', verificationToken: 'tok_ft_10294', type: 'FUNDED_TRADER', publicDisplayName: 'CORE 50K — Funded Trader', amountMicros: 50_000 * M, status: 'ISSUED', issuedAt: now - 34 * DAY, accountId: 'f-funded', renderStatus: 'RENDERED', hasImage: true, hasPdf: true },
  { id: 'c2', certificatePublicId: 'HT-PO-20571', verificationToken: 'tok_po_20571', type: 'PAYOUT', publicDisplayName: 'Payout Award', amountMicros: 2_250 * M, status: 'ISSUED', issuedAt: now - 6 * DAY, accountId: 'f-large', renderStatus: 'RENDERED', hasImage: true, hasPdf: false },
  { id: 'c3', certificatePublicId: 'HT-TC-10880', verificationToken: 'tok_tc_10880', type: 'TENK_CLUB', publicDisplayName: '$10K Club', amountMicros: 10_000 * M, status: 'ISSUED', issuedAt: now - 61 * DAY, accountId: 'f-large', renderStatus: 'RENDERED', hasImage: true, hasPdf: true },
  { id: 'c4', certificatePublicId: 'HT-AC-33120', verificationToken: 'tok_ac_33120', type: 'ACCOUNT_COMPLETED', publicDisplayName: 'CORE 100K — Account Completed', amountMicros: 25_000 * M, status: 'ISSUED', issuedAt: now - 40 * DAY, accountId: 'f-eval', renderStatus: 'RENDERED', hasImage: true, hasPdf: false },
  { id: 'c5', certificatePublicId: 'HT-FC-41007', verificationToken: 'tok_fc_41007', type: 'FIFTYK_CLUB', publicDisplayName: '$50K Club', amountMicros: 50_000 * M, status: 'ISSUED', issuedAt: now - 3 * DAY, accountId: 'f-large', renderStatus: 'RENDERED', hasImage: true, hasPdf: true },
];

export const FIXTURE_BILLING: BillingView = {
  totalSpentMicros: 897 * M,
  orderCount: 3,
  activeEntitlements: 2,
  paymentMethod: { brand: 'Visa', last4: '4242', expMonth: 8, expYear: 2028, isDefault: true, billingName: 'A. Trader', billingEmail: 'trader@example.com', country: 'United States' },
  orders: [
    { id: 'o1', dateMs: now - 61 * DAY, item: 'CORE 150K Evaluation', amountMicros: 549 * M, state: 'PAID', accountId: 'f-large' },
    { id: 'o2', dateMs: now - 40 * DAY, item: 'CORE 100K Evaluation', amountMicros: 349 * M, state: 'PAID', accountId: 'f-eval' },
    { id: 'o3', dateMs: now - 34 * DAY, item: 'CORE 50K Evaluation', amountMicros: 199 * M, state: 'REFUNDED', accountId: 'f-funded' },
  ],
};

export const FIXTURE_SUPPORT: SupportView = {
  openCount: 1,
  tickets: [
    { id: 't1', ref: 'HT-4821', subject: 'Payout timing question', state: 'WAITING', updatedMs: now - 1 * DAY },
    { id: 't2', ref: 'HT-4790', subject: 'Reset my failed evaluation', state: 'RESOLVED', updatedMs: now - 12 * DAY },
  ],
};

export const FIXTURE_ACTIVITY: ActivityItem[] = [
  { when: 'Today', label: 'CORE 100K evaluation — balance updated', amount: '+$3,200', amountTone: 'positive' },
  { when: '2 days ago', label: 'CORE 150K payout requested', amount: '$1,250', amountTone: 'muted' },
  { when: '6 days ago', label: 'CORE 150K payout paid', amount: '+$2,250', amountTone: 'positive' },
  { when: '3 days ago', label: 'SELECT 100K account breached', amount: '-$4,100', amountTone: 'negative' },
];

// ---- Human-review #2: portfolio performance series + zero-customer state --------
import type { SeriesPoint } from './primitives';
import type { ProfileView } from './profile';

/** Dev-only account-center identity. Shows the display/legal-identity SEPARATION and a
 *  realistic security/verification posture — never real PII (see PORTAL_V2_PROFILE_IDENTITY.md). */
export const FIXTURE_PROFILE: ProfileView = {
  email: 'trader@example.com',
  publicDisplayName: 'A. Trader',
  defaultDisplayName: 'A. Trader',
  legalNameOnFile: true,
  memberSinceMs: now - 61 * DAY,
  verification: 'VERIFIED',
  security: { mfaEnabled: true, activeSessions: 2, lastSignInMs: now - 1 * DAY },
  notifications: { email: true, sms: true },
};

/** Zero-customer account-center: a brand-new customer, nothing earned, nothing verified. */
export const FIXTURE_PROFILE_EMPTY: ProfileView = {
  email: 'newtrader@example.com',
  publicDisplayName: null,
  defaultDisplayName: null,
  legalNameOnFile: false,
  memberSinceMs: now - 1 * DAY,
  verification: 'NOT_STARTED',
  security: { mfaEnabled: false, activeSessions: 1, lastSignInMs: now },
  notifications: { email: true, sms: false },
};

/** Dev-only cumulative realized P&L across the customer's accounts (portfolio level).
 *  In production this is one authoritative projection (see PORTAL_V2_PERFORMANCE_METRICS.md);
 *  here it is a representative monotone-ish walk so the chart is exercised. */
export const FIXTURE_PORTFOLIO_SERIES: SeriesPoint[] = (() => {
  const pts: SeriesPoint[] = [];
  let v = 0; let seed = 20260101;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const start = now - 120 * DAY;
  for (let i = 0; i <= 120; i += 1) { v += Math.round((rnd() - 0.42) * 900) * M / 1; pts.push({ t: start + i * DAY, v: Math.max(-20000 * M, v) }); }
  return pts;
})();

/** A deterministic ZERO-CUSTOMER view: a real new customer with no business records. */
export const FIXTURE_VIEW_EMPTY_CUSTOMER: AccountsView = { accounts: [], activeSlotsUsed: 0, maxActiveSlots: 5 };
export const FIXTURE_PAYOUTS_EMPTY: PayoutsView = { totalPaidMicros: 0, availableMicros: 0, inReviewMicros: 0, cyclesText: '0 of 5', standing: [], history: [] };
export const FIXTURE_BILLING_EMPTY: BillingView = { totalSpentMicros: 0, orderCount: 0, activeEntitlements: 0, orders: [] };
export const FIXTURE_SUPPORT_EMPTY: SupportView = { openCount: 0, tickets: [] };

// ---------------------------------------------------------------------------
// Progress & Achievements (Experience Layer Phase 1) — dev-review fixtures.
// Unmistakably development values; no production path imports them. In production
// this view comes from GET /api/v1/portal/progress (authoritative server data).
// ---------------------------------------------------------------------------
import type { ProgressView, GoalView } from './progress-page';

const M10K = 10_000 * M;

/** A funded, paid customer well into their journey (exercises clubs + timeline). */
export const FIXTURE_PROGRESS: ProgressView = {
  memberSinceMs: now - 420 * DAY,
  hero: {
    lifetimePaidTraderShareMicros: 62_400 * M,
    fundedAccounts: 2,
    evaluationsPassed: 3,
    achievementsEarned: 6,
    currentClub: 'FIFTYK_CLUB',
    nextClub: { key: 'HUNDREDK_CLUB', thresholdMicros: 100_000 * M, remainingMicros: 37_600 * M },
  },
  clubs: [
    { key: 'TENK_CLUB', thresholdMicros: M10K, achieved: true, achievedAt: now - 300 * DAY, physical: false },
    { key: 'FIFTYK_CLUB', thresholdMicros: 50_000 * M, achieved: true, achievedAt: now - 60 * DAY, physical: false },
    { key: 'HUNDREDK_CLUB', thresholdMicros: 100_000 * M, achieved: false, achievedAt: null, physical: true },
  ],
  milestones: [
    { id: 'm-fiftyk', type: 'FIFTYK_CLUB', at: now - 60 * DAY, meta: null },
    { id: 'm-tenk', type: 'TENK_CLUB', at: now - 300 * DAY, meta: null },
    { id: 'm-first', type: 'FIRST_PAYOUT', at: now - 350 * DAY, meta: null },
    { id: 'm-funded', type: 'FUNDED', at: now - 380 * DAY, meta: null },
  ],
  goals: [
    {
      id: 'g-100k', title: 'Reach the $100K Club', note: 'My big one for this year.', kind: 'TRACKED',
      metric: 'CUMULATIVE_PAYOUT_MICROS', targetValue: 100_000 * M, currentValue: 62_400 * M,
      status: 'ACTIVE', pinned: true, completedAt: null, createdAt: now - 70 * DAY,
    },
    {
      id: 'g-fund3', title: 'Earn a third funded account', kind: 'TRACKED',
      metric: 'FUNDED_ACCOUNTS', targetValue: 3, currentValue: 2,
      status: 'ACTIVE', pinned: true, completedAt: null, createdAt: now - 40 * DAY, note: null,
    },
    {
      id: 'g-routine', title: 'Build a consistent weekly review habit', note: 'Every Sunday.', kind: 'MANUAL',
      metric: null, targetValue: null, currentValue: null,
      status: 'ACTIVE', pinned: false, completedAt: null, createdAt: now - 20 * DAY,
    },
    {
      id: 'g-first-payout', title: 'Withdraw my first payout', kind: 'MANUAL',
      metric: null, targetValue: null, currentValue: null,
      status: 'COMPLETED', pinned: false, completedAt: now - 350 * DAY, createdAt: now - 400 * DAY, note: null,
    },
  ] as GoalView[],
  achievementsPublic: false,
};

/** Zero-customer journey: truthful zeros, a welcoming start. */
export const FIXTURE_PROGRESS_EMPTY: ProgressView = {
  memberSinceMs: now - 2 * DAY,
  hero: {
    lifetimePaidTraderShareMicros: 0, fundedAccounts: 0, evaluationsPassed: 0,
    achievementsEarned: 0, currentClub: null, nextClub: { key: 'TENK_CLUB', thresholdMicros: M10K, remainingMicros: M10K },
  },
  clubs: [
    { key: 'TENK_CLUB', thresholdMicros: M10K, achieved: false, achievedAt: null, physical: false },
    { key: 'FIFTYK_CLUB', thresholdMicros: 50_000 * M, achieved: false, achievedAt: null, physical: false },
    { key: 'HUNDREDK_CLUB', thresholdMicros: 100_000 * M, achieved: false, achievedAt: null, physical: true },
  ],
  milestones: [],
  goals: [],
  achievementsPublic: false,
};
