/**
 * Binding between the pure rule engine and the database.
 *
 * The arithmetic lives in @atlas/core; everything here is about reading the
 * account's programme, marking it to the market, and persisting what the rules
 * decided. Nothing in this file decides anything: if a rule question is being
 * answered with an `if` here, it belongs in the core instead.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import {
  PRACTICE_RULES,
  advanceDrawdown,
  evaluateRules,
  lockExpired,
  rollTradingDay,
  type DailyHistory,
  type RuleConfig,
  type RuleMark,
  type RuleState,
  type RuleStatus,
} from '@atlas/core';
import {
  accountProfileVersions,
  accountProfiles,
  accounts,
  dailyAccountStats,
  ruleTemplates,
} from '../db/schema.js';
import type { Database } from '../db/client.js';

type AccountRow = InferSelectModel<typeof accounts>;
type TemplateRow = InferSelectModel<typeof ruleTemplates>;

/**
 * Build the rule configuration for an account.
 *
 * The programme's template supplies the defaults and the account's own
 * overrides are merged on top, so a single trader can be moved onto different
 * terms - a reduced drawdown, a tighter daily limit - without inventing a new
 * template for them.
 */
export function ruleConfigFor(account: AccountRow, template: TemplateRow | undefined): RuleConfig {
  const base: RuleConfig = template
    ? {
        accountSizeMicros: template.accountSizeMicros,
        profitTargetMicros: template.profitTargetMicros,
        maxLossMicros: template.maxLossMicros,
        drawdownType: template.drawdownType as RuleConfig['drawdownType'],
        trailingLockAtMicros: template.trailingLockAtMicros,
        dailyLossLimitMicros: template.dailyLossLimitMicros,
        dailyLossPolicy: template.dailyLossPolicy as RuleConfig['dailyLossPolicy'],
        consistencyFormula: template.consistencyFormula as RuleConfig['consistencyFormula'],
        consistencyThreshold: template.consistencyThreshold,
        minTradingDays: template.minTradingDays,
        minWinningDays: template.minWinningDays,
        maxTradingDays: template.maxTradingDays,
        minDailyPnlToCountMicros: template.minDailyPnlToCountMicros,
        minWinningDayPnlMicros: template.minWinningDayPnlMicros,
        maxContracts: template.maxContracts,
        microsCountAsFraction: template.microsCountAsFraction,
        flattenOnBreach: template.flattenOnBreach,
      }
    : PRACTICE_RULES;

  const overrides = (account.ruleOverrides ?? null) as Partial<RuleConfig> | null;
  return normalizeRuleConfig(overrides ? { ...base, ...overrides } : base);
}

/** Keep a hand-edited override from producing a configuration that cannot hold. */
export function normalizeRuleConfig(config: RuleConfig): RuleConfig {
  return {
    ...config,
    profitTargetMicros: Math.max(0, Math.round(config.profitTargetMicros)),
    maxLossMicros: Math.max(0, Math.round(config.maxLossMicros)),
    dailyLossLimitMicros:
      config.dailyLossLimitMicros === null
        ? null
        : Math.max(1, Math.round(config.dailyLossLimitMicros)),
    consistencyThreshold:
      config.consistencyThreshold === null
        ? null
        : Math.min(1, Math.max(0.01, config.consistencyThreshold)),
    minTradingDays: Math.max(0, Math.floor(config.minTradingDays)),
    minWinningDays: Math.max(0, Math.floor(config.minWinningDays)),
    maxTradingDays:
      config.maxTradingDays === null ? null : Math.max(1, Math.floor(config.maxTradingDays)),
    maxContracts: Math.max(1, Math.floor(config.maxContracts)),
  };
}

export function ruleStateFor(account: AccountRow): RuleState {
  return {
    // The rules read THEIR status, not the effective one. An account an
    // operator has disabled is still, as far as the programme is concerned,
    // wherever the rules last left it - and that is what it returns to when
    // the hold is lifted.
    status: (account.ruleStatus ?? account.status) as RuleState['status'],
    startingBalanceMicros: account.startingBalanceMicros,
    balanceMicros: account.balanceMicros,
    highWaterMarkMicros: account.highWaterMarkMicros,
    drawdownFloorMicros: account.drawdownFloorMicros,
    dayStartBalanceMicros: account.dayStartBalanceMicros,
    dayStartEquityMicros: account.dayStartEquityMicros,
    currentTradeDate: account.currentTradeDate,
    tradingDaysCount: account.tradingDaysCount,
    winningDaysCount: account.winningDaysCount,
    bestDayProfitMicros: account.bestDayProfitMicros,
    lockedUntilDate: account.lockedUntilDate,
    failedReason: account.failedReason,
  };
}

/**
 * What the completed days add up to.
 *
 * The consistency rule divides the best single day into the account's TOTAL net
 * profit, which is simply how far the balance is above where it started. Using
 * a separately accumulated sum would let the two drift apart, and the one a
 * trader can verify from their own statement is this one.
 */
export function historyFor(account: AccountRow): DailyHistory {
  return {
    bestDayProfitMicros: account.bestDayProfitMicros,
    totalProfitMicros: Math.max(0, account.balanceMicros - account.startingBalanceMicros),
    tradingDaysCount: account.tradingDaysCount,
    winningDaysCount: account.winningDaysCount,
  };
}

export interface RuleApplication {
  readonly status: RuleStatus;
  readonly state: RuleState;
  /** True when anything about the persisted state changed. */
  readonly changed: boolean;
  /** Set when this evaluation is the one that broke a rule. */
  readonly newBreach: RuleStatus['breach'];
  readonly rolledDay: boolean;
}

/**
 * Run the rules for one mark and work out what should be persisted.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Roll the trading day first, so a mark that arrives on a new date is
 *      judged against that date's limits rather than yesterday's.
 *   2. Advance the drawdown anchor, so the floor includes profit just made.
 *   3. Evaluate, so a breach is measured against the anchor as it now stands.
 */
export function applyRules(
  config: RuleConfig,
  state: RuleState,
  mark: RuleMark,
  history: DailyHistory,
): RuleApplication {
  const roll = rollTradingDay(config, state, mark);
  const rolled = roll.state;
  const rolledDay = roll.closed !== null || rolled.currentTradeDate !== state.currentTradeDate;

  const historyAfterRoll: DailyHistory = rolledDay
    ? {
        ...history,
        bestDayProfitMicros: rolled.bestDayProfitMicros,
        tradingDaysCount: rolled.tradingDaysCount,
        winningDaysCount: rolled.winningDaysCount,
      }
    : history;

  const anchored = advanceDrawdown(config, rolled, mark);
  const withAnchor: RuleState = { ...rolled, ...anchored, balanceMicros: mark.balanceMicros };

  const status = evaluateRules(config, withAnchor, mark, historyAfterRoll);

  const next: RuleState = {
    ...withAnchor,
    status: status.status,
    failedReason:
      status.status === 'FAILED'
        ? (withAnchor.failedReason ?? status.breach?.code ?? 'MAX_LOSS_LIMIT')
        : withAnchor.failedReason,
    lockedUntilDate:
      status.status === 'LOCKED'
        ? (withAnchor.lockedUntilDate ?? nextDate(mark.tradingDate))
        : lockExpired(withAnchor, mark.tradingDate)
          ? null
          : withAnchor.lockedUntilDate,
  };

  const changed =
    next.status !== state.status ||
    next.highWaterMarkMicros !== state.highWaterMarkMicros ||
    next.drawdownFloorMicros !== state.drawdownFloorMicros ||
    next.currentTradeDate !== state.currentTradeDate ||
    next.dayStartBalanceMicros !== state.dayStartBalanceMicros ||
    next.dayStartEquityMicros !== state.dayStartEquityMicros ||
    next.tradingDaysCount !== state.tradingDaysCount ||
    next.winningDaysCount !== state.winningDaysCount ||
    next.bestDayProfitMicros !== state.bestDayProfitMicros ||
    next.lockedUntilDate !== state.lockedUntilDate ||
    next.failedReason !== state.failedReason;

  const wasBreached = state.status === 'FAILED' || state.status === 'LOCKED';
  return {
    status,
    state: next,
    changed,
    newBreach: status.breach && !wasBreached ? status.breach : null,
    rolledDay,
  };
}

/** The day after a trading date. A lockout runs until this date arrives. */
export function nextDate(tradingDate: string): string {
  const d = new Date(`${tradingDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Persist the rule state the evaluation produced.
 *
 * The rule status is always written. The EFFECTIVE status is only written when
 * no operator hold is in place: an administrator who locked an account did not
 * ask for the next market tick to unlock it.
 */
export async function persistRuleState(
  db: Database,
  accountId: string,
  next: RuleState,
): Promise<void> {
  await db
    .update(accounts)
    .set({
      ruleStatus: next.status,
      status: sql`case when ${accounts.adminHold} is null then ${next.status} else ${accounts.status} end`,
      highWaterMarkMicros: next.highWaterMarkMicros,
      drawdownFloorMicros: next.drawdownFloorMicros,
      currentTradeDate: next.currentTradeDate,
      dayStartBalanceMicros: next.dayStartBalanceMicros,
      dayStartEquityMicros: next.dayStartEquityMicros,
      tradingDaysCount: next.tradingDaysCount,
      winningDaysCount: next.winningDaysCount,
      bestDayProfitMicros: next.bestDayProfitMicros,
      lockedUntilDate: next.lockedUntilDate,
      failedReason: next.failedReason,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));
}

/** Write the day that just closed into the daily statistics. */
export async function recordClosedDay(
  db: Database,
  accountId: string,
  closed: {
    tradeDate: string;
    startingBalanceMicros: number;
    endingBalanceMicros: number;
    counted: boolean;
  },
): Promise<void> {
  await db
    .insert(dailyAccountStats)
    .values({
      accountId,
      tradeDate: closed.tradeDate,
      startingBalanceMicros: closed.startingBalanceMicros,
      endingBalanceMicros: closed.endingBalanceMicros,
      realizedPnlMicros: closed.endingBalanceMicros - closed.startingBalanceMicros,
      highEquityMicros: Math.max(closed.startingBalanceMicros, closed.endingBalanceMicros),
      lowEquityMicros: Math.min(closed.startingBalanceMicros, closed.endingBalanceMicros),
      counted: closed.counted,
    })
    .onConflictDoUpdate({
      target: [dailyAccountStats.accountId, dailyAccountStats.tradeDate],
      set: {
        endingBalanceMicros: closed.endingBalanceMicros,
        realizedPnlMicros: closed.endingBalanceMicros - closed.startingBalanceMicros,
        counted: closed.counted,
        updatedAt: new Date(),
      },
    });
}

/** Daily statistics for an account, newest first. */
export async function dailyStats(db: Database, accountId: string, limit = 60) {
  return db
    .select()
    .from(dailyAccountStats)
    .where(eq(dailyAccountStats.accountId, accountId))
    .orderBy(sql`${dailyAccountStats.tradeDate} DESC`)
    .limit(limit);
}

/**
 * The terms an account trades under, as the rule engine wants them.
 *
 * An account pinned to a product VERSION takes its terms from there; one that
 * predates products falls back to its rule template. Both arrive here in the
 * same shape, so nothing downstream - the engine least of all - has to know
 * which kind of account it is looking at.
 *
 * A version whose stored configuration is unreadable falls back to the
 * template rather than to a guess: the alternative is evaluating a trader
 * against numbers nobody chose.
 */
function templateFromVersion(
  version: InferSelectModel<typeof accountProfileVersions>,
  profile: InferSelectModel<typeof accountProfiles> | null,
  fallback: TemplateRow | null,
): TemplateRow | undefined {
  const config = version.config as { rules?: Partial<RuleConfig>; payoutRules?: unknown } | null;
  const rules = config?.rules;
  if (!rules || typeof rules.accountSizeMicros !== 'number') return fallback ?? undefined;

  return {
    id: version.id,
    name: profile?.name ?? 'Product',
    accountType: profile?.accountType ?? 'PRACTICE',
    accountSizeMicros: rules.accountSizeMicros,
    profitTargetMicros: rules.profitTargetMicros ?? 0,
    maxLossMicros: rules.maxLossMicros ?? 0,
    drawdownType: rules.drawdownType ?? 'STATIC',
    trailingLockAtMicros: rules.trailingLockAtMicros ?? null,
    dailyLossLimitMicros: rules.dailyLossLimitMicros ?? null,
    consistencyFormula: rules.consistencyFormula ?? 'BEST_DAY_OVER_TOTAL',
    consistencyThreshold: rules.consistencyThreshold ?? null,
    maxContracts: rules.maxContracts ?? 1,
    microsCountAsFraction: rules.microsCountAsFraction ?? false,
    minTradingDays: rules.minTradingDays ?? 0,
    maxTradingDays: rules.maxTradingDays ?? null,
    minDailyPnlToCountMicros: rules.minDailyPnlToCountMicros ?? 0,
    minWinningDays: rules.minWinningDays ?? 0,
    minWinningDayPnlMicros: rules.minWinningDayPnlMicros ?? 1,
    dailyLossPolicy: rules.dailyLossPolicy ?? 'LOCK_DAY',
    flattenOnBreach: rules.flattenOnBreach ?? true,
    payoutRules: (config?.payoutRules ?? fallback?.payoutRules ?? {}) as never,
    isSystem: fallback?.isSystem ?? false,
    createdAt: version.createdAt,
  };
}

export async function loadAccountAndTemplate(
  db: Database,
  accountId: string,
): Promise<{ account: AccountRow; template: TemplateRow | undefined } | null> {
  const [row] = await db
    .select({
      account: accounts,
      template: ruleTemplates,
      version: accountProfileVersions,
      profile: accountProfiles,
    })
    .from(accounts)
    .leftJoin(ruleTemplates, eq(accounts.ruleTemplateId, ruleTemplates.id))
    .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
    .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
    .where(and(eq(accounts.id, accountId)));
  if (!row) return null;

  const pinned = row.version
    ? templateFromVersion(row.version, row.profile, row.template)
    : undefined;
  return { account: row.account, template: pinned ?? row.template ?? undefined };
}
