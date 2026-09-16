/** Prop evaluation account contracts. Rules are data, never hardcoded logic. */

export type AccountType = 'EVALUATION' | 'FUNDED' | 'PRACTICE';

export type AccountStatus =
  | 'ACTIVE'
  | 'GOAL_REACHED'
  | 'PASSED'
  | 'FAILED'
  | 'LOCKED'
  | 'SUSPENDED';

export type DrawdownType = 'STATIC' | 'INTRADAY_TRAILING' | 'EOD_TRAILING';

/**
 * How the consistency rule is expressed. Prop firms differ, so the formula is
 * selected by data rather than baked into the engine.
 */
export type ConsistencyFormula =
  /** bestDayProfit / totalNetProfit must be <= threshold. */
  | 'BEST_DAY_OVER_TOTAL'
  /** bestDayProfit / profitTarget must be <= threshold. */
  | 'BEST_DAY_OVER_TARGET';

export interface PayoutRules {
  readonly minTradingDaysForPayout: number;
  readonly maxPayoutPercent: number;
  readonly profitSplitPercent: number;
  readonly minPayoutMicros: number;
}

export interface RuleTemplate {
  readonly id: string;
  readonly name: string;
  readonly accountType: AccountType;
  /** Starting balance, micro-dollars. */
  readonly accountSizeMicros: number;
  /** Profit required above starting balance to reach the goal, micro-dollars. */
  readonly profitTargetMicros: number;
  /** Total permitted loss, micro-dollars (positive magnitude). */
  readonly maxLossMicros: number;
  readonly drawdownType: DrawdownType;
  /**
   * For trailing types: stop trailing once the buffer reaches this profit above
   * starting balance. Null = trail forever.
   */
  readonly trailingLockAtMicros: number | null;
  /** Daily loss limit, micro-dollars (positive magnitude). Null = none. */
  readonly dailyLossLimitMicros: number | null;
  readonly consistencyFormula: ConsistencyFormula;
  /** e.g. 0.4 means the best day may not exceed 40%. Null = no consistency rule. */
  readonly consistencyThreshold: number | null;
  /** Max total contracts across all open positions, normalized to micro-equivalents. */
  readonly maxContracts: number;
  /** Micro contracts count as 1/10 toward maxContracts when true. */
  readonly microsCountAsFraction: boolean;
  readonly minTradingDays: number;
  readonly maxTradingDays: number | null;
  readonly payoutRules: PayoutRules;
  /** A trading day only counts if net activity meets this threshold. */
  readonly minDailyPnlToCountMicros: number;
  readonly createdAt: number;
}

export interface Account {
  readonly id: string;
  readonly userId: string;
  readonly ruleTemplateId: string;
  readonly name: string;
  readonly accountType: AccountType;
  readonly status: AccountStatus;
  readonly startingBalanceMicros: number;
  /** Settled cash: starting balance + realized P&L - fees. */
  readonly balanceMicros: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  /** Highest value the drawdown engine has anchored to. */
  readonly highWaterMarkMicros: number;
  /** Current computed drawdown floor. Equity below this fails the account. */
  readonly drawdownFloorMicros: number;
  readonly tradingDaysCount: number;
  readonly currentTradeDate: string | null;
  /** Balance at the start of the current trading day. */
  readonly dayStartBalanceMicros: number;
  readonly dayStartEquityMicros: number;
  /** Monotonic per-account event sequence, for WS recovery. */
  readonly seq: number;
  readonly failedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Live computed account view. Derived server-side, sent to the client. */
export interface AccountView extends Account {
  readonly openPnlMicros: number;
  readonly equityMicros: number;
  readonly dayPnlMicros: number;
  readonly dayRealizedPnlMicros: number;
  readonly remainingDrawdownMicros: number;
  readonly remainingDailyLossMicros: number | null;
  readonly profitTargetProgressMicros: number;
  readonly consistencyRatio: number | null;
  readonly consistencyPassing: boolean;
  readonly openContracts: number;
}

export interface DailyAccountStat {
  readonly accountId: string;
  /** Exchange trading date, YYYY-MM-DD. */
  readonly tradeDate: string;
  readonly startingBalanceMicros: number;
  readonly endingBalanceMicros: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  readonly highEquityMicros: number;
  readonly lowEquityMicros: number;
  readonly tradeCount: number;
  readonly counted: boolean;
}

export type AccountEventType =
  | 'ACCOUNT_CREATED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_ACCEPTED'
  | 'ORDER_REJECTED'
  | 'ORDER_MODIFIED'
  | 'ORDER_CANCELED'
  | 'ORDER_FILLED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'POSITION_OPENED'
  | 'POSITION_CHANGED'
  | 'POSITION_CLOSED'
  | 'TRADE_CLOSED'
  | 'RISK_RULE_TRIGGERED'
  | 'DRAWDOWN_UPDATED'
  | 'TRADING_DAY_ROLLED'
  | 'ACCOUNT_GOAL_REACHED'
  | 'ACCOUNT_PASSED'
  | 'ACCOUNT_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_RESET';

export interface AccountEvent {
  readonly id: string;
  readonly accountId: string;
  readonly seq: number;
  readonly type: AccountEventType;
  readonly userId: string | null;
  readonly source: 'USER' | 'ENGINE' | 'RISK' | 'SYSTEM';
  readonly request: unknown;
  readonly prevState: unknown;
  readonly newState: unknown;
  readonly createdAt: number;
}
