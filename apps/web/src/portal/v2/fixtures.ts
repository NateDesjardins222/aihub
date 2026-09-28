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
