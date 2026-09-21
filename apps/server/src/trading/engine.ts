/**
 * The trading engine host.
 *
 * Owns the authoritative order flow. Everything here happens inside a
 * per-account mutex and a database transaction, so a market event and an order
 * submission can never interleave halfway through a position update.
 *
 * The browser may REQUEST (submit, modify, cancel). It may never ASSERT
 * (filled, position, P&L). Every number the client sees originates here.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { InstrumentSpec, RejectReason, Side, TimeInForce } from '@atlas/contracts';
import {
  applyFill,
  avgEntryTicks,
  createOrder,
  flatPosition,
  isOpen,
  matchOrders,
  modifyOrder,
  normalizeEnvironment,
  remainingQty,
  unrealizedPnlMicros,
  type ClosedLot,
  type EngineOrder,
  type MarketSnapshot,
  type PositionState,
  type SimulationEnvironment,
} from '@atlas/core';
import {
  priceToTicks,
  ticksToPrice,
  requireInstrument,
  getInstrument,
  listInstruments,
  tradingDate,
  contractWeight,
  contractResolver,
} from '@atlas/instruments';
import type { Database } from '../db/client.js';
import {
  accountEvents,
  accountProfileVersions,
  accounts,
  executions,
  orders as ordersTable,
  positions as positionsTable,
  practiceSessions,
  riskEvents,
  trades,
} from '../db/schema.js';
import type { NormalizedBar, NormalizedQuote } from '@atlas/contracts';
import type { Freshness } from '../marketdata/quote-store.js';

/**
 * The slice of the market the engine needs.
 *
 * Declared as an interface rather than taking MarketDataService directly, so
 * the engine can be driven by a scripted market in tests. An execution engine
 * that can only be tested against a live feed cannot be tested at all.
 */
export interface MarketView {
  readonly bus: {
    onAnyQuote(listener: (q: NormalizedQuote) => void): () => void;
    onAnyBar(listener: (b: NormalizedBar) => void): () => void;
  };
  getQuote(symbol: string): NormalizedQuote | null;
  markPrice(symbol: string): number | null;
  freshness(symbol: string): Freshness;
  lastClosedBar(symbol: string): NormalizedBar | null;
  /** Length of the bars `lastClosedBar` returns, in ms. */
  baseBarMs(symbol: string): number;
  /**
   * True when the feed is a replay rather than a live market.
   *
   * The engine uses it for one thing only: which clock measures simulated
   * latency. Nothing about HOW an order fills changes.
   */
  isReplay(): boolean;
  /**
   * Which market the feed is serving, as a stable identity.
   *
   * A position is marked ONLY by the era it was opened in. Market data is
   * global and accounts are not: starting a practice replay used to re-mark
   * every open position at the recording's prices, reporting thousands of
   * dollars of profit or loss that no execution justified - and committing the
   * profitable side of it into the account's high-water mark.
   */
  era(): string;
  /**
   * Optional, and only a test harness implements it.
   *
   * A scripted market that can ask "has the engine finished reacting?" makes
   * an engine test deterministic. Without it the tests slept for a fixed
   * thirty milliseconds and asserted, which passed until the machine was busy
   * and then failed for reasons that had nothing to do with the code.
   */
  attachIdleProbe?(probe: () => Promise<void>): void;
}
import type postgres from 'postgres';
import { AccountLock } from './account-lock.js';
import { enqueueOutbox } from '../platform/outbox.js';
import {
  applyRules,
  historyFor,
  loadAccountAndTemplate,
  persistRuleState,
  recordClosedDay,
  ruleConfigFor,
  ruleStateFor,
} from './account-rules.js';
import { rollTradingDay, statusFromState, type RuleStatus } from '@atlas/core';
import {
  checkOrder,
  increasingQty,
  type InstrumentPolicy,
  type RiskRejection,
} from './risk.js';
import {
  presentOrder,
  presentPosition,
  readBracket,
  scaleTicks,
  toEngineOrder,
  toEnginePosition,
  toOrderValues,
  toPositionValues,
} from './mapping.js';

/** How often open accounts are revalued and pushed, in milliseconds. */
const VALUATION_INTERVAL_MS = 1_000;

/**
 * The instrument whose session calendar defines an account's trading day.
 *
 * An account trades products on different exchanges, so one calendar has to
 * win. The equity-index one is the CME business day - 17:00 Chicago to 17:00
 * Chicago - which is what a futures account is settled on.
 */
const ACCOUNT_CALENDAR_SYMBOL = 'NQ';

/**
 * How far the per-account queue may grow before observations are coalesced
 * even for an account with working orders.
 *
 * The exemption above is what keeps a fill from being skipped, and it is worth
 * a queue: at a hundred times speed a replay can deliver events faster than
 * they can be matched. But an unbounded queue is worse than a missed
 * intermediate price - it delays the trader's OWN next order behind every
 * event in it. Past this depth the engine falls back to coalescing, which
 * costs fidelity on intermediate prices but keeps the terminal responsive.
 */
const MAX_QUEUED_MATCHES = 16;

export class OrderRejectedError extends Error {
  constructor(
    readonly reason: RejectReason,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrderRejectedError';
  }
}

/**
 * The extremes of every genuine print observed since a match pass last ran.
 *
 * Prices in ticks, so the excursions are integer arithmetic like everything
 * else the engine records.
 */
interface PriceWindow {
  minTicks: number;
  maxTicks: number;
}

/**
 * One market observation, handed to the matcher by the event that produced it.
 *
 * Carrying it rather than re-reading the market is what makes a replayed
 * session repeatable: the pass prices itself off the observation it was
 * triggered by, however long it waited for the account's lock.
 */
interface MatchPass {
  /**
   * The pinned observation, or null to price off the market as it stands.
   *
   * Only a REPLAY pins one. Live, observations can be coalesced under load, and
   * a pass holding the observation that triggered it would then be stuck in the
   * past: the burst that dropped forty prints would leave the survivor matching
   * the first of them, and a stop the market ran through would not fire. Live,
   * the freshest observation is the honest one; in a replay, nothing is dropped
   * and the triggering observation is the exact one.
   */
  readonly observed: MarketSnapshot | null;
  readonly window: PriceWindow | null;
}

export interface BracketOffsets {
  readonly stopLossTicks?: number | null;
  readonly takeProfitTicks?: number | null;
  readonly trailingStopTicks?: number | null;
}

/**
 * Where a position's protective orders should sit, in ticks.
 *
 * `undefined` leaves a leg alone, `null` removes it. The distinction matters:
 * moving a stop must not silently cancel a target the trader cannot see.
 */
export interface ProtectionLevels {
  readonly stopTicks?: number | null;
  readonly targetTicks?: number | null;
}

export interface SubmitOrderInput {
  readonly accountId: string;
  /** Null when the ENGINE placed the order, e.g. liquidating after a breach. */
  readonly userId: string | null;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: number;
  readonly type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT' | 'TRAILING_STOP';
  readonly limitTicks?: number | null;
  readonly stopTicks?: number | null;
  readonly tif?: TimeInForce;
  readonly trailTicks?: number | null;
  readonly bracket?: BracketOffsets | null;
  /**
   * An order the ENGINE is sending to close exposure after a rule breach.
   *
   * It skips the account-status gate - a failed account must still be able to
   * be flattened, or a breach would leave the position open forever - but every
   * market and data check still applies: a liquidation cannot fill on data that
   * would not fill anything else.
   */
  readonly liquidation?: boolean;
}

/**
 * A live account valuation.
 *
 * Pushed as prices move, not only when orders change. Unrealized P&L is a
 * function of the MARK, so an account with an open position revalues on every
 * market event even though nothing about its orders has changed. Leaving the
 * client to notice that for itself would either freeze the figure or mean the
 * browser computing authoritative P&L, and neither is acceptable.
 */
export interface AccountValuation {
  readonly accountId: string;
  readonly balanceMicros: number;
  /**
   * NULL when the account cannot be priced.
   *
   * `unmarkable` says which positions are the reason. Every figure derived
   * from a mark is null in that case rather than guessed at.
   */
  readonly equityMicros: number | null;
  readonly openPnlMicros: number | null;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  readonly dayPnlMicros: number | null;
  readonly remainingDrawdownMicros: number | null;
  readonly openContracts: number;
  readonly positions: ReturnType<typeof presentPosition>[];
  /**
   * Open positions the platform cannot price right now, with the market each
   * was opened against and the one now being served. Empty in normal use.
   */
  readonly unmarkable: ReadonlyArray<{
    readonly symbol: string;
    readonly openedAgainst: string;
    readonly nowServing: string;
  }>;
  /**
   * Where the account stands against its programme's rules.
   *
   * Sent with the valuation rather than fetched separately, because a remaining
   * drawdown that lags the equity it is derived from is worse than not showing
   * it at all.
   */
  readonly rules: RuleStatus;
  readonly at: number;
}

export interface EngineChange {
  readonly accountId: string;
  readonly seq: number;
  readonly orders: ReturnType<typeof presentOrder>[];
  readonly position: ReturnType<typeof presentPosition> | null;
  readonly fills: Array<{
    id: string;
    orderId: string;
    symbol: string;
    side: Side;
    qty: number;
    priceTicks: number;
    feesMicros: number;
    realizedPnlMicros: number;
    execTime: number;
  }>;
  readonly trades: Array<Record<string, unknown>>;
  readonly balanceMicros: number;
}

type ChangeListener = (change: EngineChange) => void;
type ValuationListener = (valuation: AccountValuation) => void;

export class TradingEngine {
  /**
   * Serializes every mutation of one account. In-process by default; when a
   * postgres connection is supplied it is also cross-process (a PostgreSQL
   * advisory lock), so two server instances cannot corrupt one account.
   */
  private readonly mutex: AccountLock;
  private readonly listeners = new Set<ChangeListener>();
  private readonly valuationListeners = new Set<ValuationListener>();
  /** Account+symbol pairs with a market-event match already queued. */
  private readonly pendingMatches = new Set<string>();
  /**
   * Account+symbol pairs that have something working.
   *
   * It decides whether a market event may be coalesced away. An observation
   * that could FILL an order is never skipped - skipping one would mean a price
   * the market traded was never offered to a resting order, which is both
   * wrong and unrepeatable. An observation that can only move a number may be
   * coalesced, because the next match reads the latest number anyway.
   */
  private readonly working = new Set<string>();
  /** Accounts whose rules are being enforced, so enforcement cannot recurse. */
  private readonly enforcing = new Set<string>();
  /**
   * The price range each open position has lived through, in ticks.
   *
   * Market events are COALESCED - two quotes arriving while a match is running
   * produce one match, which is what keeps the account lock short. Excursions
   * must not be coalesced with them: MAE and MFE describe the PATH, and a path
   * that skips whichever prints arrived during a busy moment is neither
   * accurate nor reproducible.
   *
   * So every observation is folded in here, synchronously, as it arrives -
   * before any queueing, matching or awaiting can reorder anything. The
   * database write still happens on the match, but it writes a range that has
   * already seen every print.
   */
  private readonly livePath = new Map<string, PriceWindow>();
  private valuationTimer: NodeJS.Timeout | null = null;
  /** Accounts currently holding a position or working order, by symbol. */
  private readonly activeSymbols = new Map<string, Set<string>>();
  private marketUnsubscribe: (() => void) | null = null;
  /** Pending latency wake-ups, so a shutdown does not leave timers running. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly pendingWakes = new Set<NodeJS.Timeout>();

  constructor(
    private readonly db: Database,
    private readonly market: MarketView,
    /**
     * The raw postgres connection, for the cross-process account advisory lock.
     * Omitted in unit tests, which are single-process: the engine then falls
     * back to the pure in-process mutex, with identical single-process behaviour.
     */
    pg?: postgres.Sql,
  ) {
    this.mutex = new AccountLock(pg);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onValuation(listener: ValuationListener): () => void {
    this.valuationListeners.add(listener);
    return () => this.valuationListeners.delete(listener);
  }

  private emit(change: EngineChange): void {
    for (const listener of this.listeners) listener(change);
  }

  // -- market wiring -------------------------------------------------------

  /**
   * Follow the market. Every quote and every closed bar is an opportunity for a
   * working order to fill, so both are fed to the matcher.
   */
  async start(): Promise<void> {
    // A scripted market can wait for the engine instead of guessing. The real
    // market data service does not implement this.
    this.market.attachIdleProbe?.(() => this.whenIdle());
    await this.refreshActiveSymbols();

    // The observation is taken HERE, synchronously, and carried into the match.
    // Reading the market again inside the match would read whatever had arrived
    // by the time the account's lock came free, so a pass triggered by one
    // observation could price itself off a later one - which makes the same
    // recording produce different fills depending on how busy the machine was.
    const offQuote = this.market.bus.onAnyQuote((quote) => {
      if (quote.last !== null) this.observePrice(quote.symbol, quote.last);
      const spec = getInstrument(quote.symbol);
      const observed = spec ? this.snapshotFor(spec) : null;
      this.background(this.onMarketEvent(quote.symbol, observed));
    });
    const offBar = this.market.bus.onAnyBar((bar) => {
      if (!bar.closed) return; // a forming bar's extremes are not final
      this.observePrice(bar.symbol, bar.high);
      this.observePrice(bar.symbol, bar.low);
      const spec = getInstrument(bar.symbol);
      const observed = spec ? this.snapshotFor(spec) : null;
      this.background(this.onMarketEvent(bar.symbol, observed));
    });
    this.marketUnsubscribe = () => {
      offQuote();
      offBar();
    };

    // Revalue open accounts on a steady cadence rather than on every tick: the
    // figure must track the market, but a push per quote per account would be
    // a lot of traffic for a number that only needs to look live.
    this.valuationTimer = setInterval(() => {
      this.background(this.publishValuations());
    }, VALUATION_INTERVAL_MS);
    this.valuationTimer.unref?.();
  }

  /** Revalue every account holding a position and push the result. */
  private async publishValuations(): Promise<void> {
    const accountIds = await this.accountsToRevalue();

    for (const accountId of accountIds) {
      // Enforce before publishing: a drawdown that has been breached should
      // reach the client as a failed account, not as a healthy one that fails a
      // second later.
      await this.mutex.run(accountId, () => this.enforceLocked(accountId));
      if (this.valuationListeners.size === 0) continue;
      const valuation = await this.valuation(accountId);
      if (valuation) for (const listener of this.valuationListeners) listener(valuation);
    }
  }

  /**
   * Accounts the rules have something to say about right now.
   *
   * Exposure is the obvious case, but not the only one: an account with a
   * resting order can breach when that order fills, and a locked-out account
   * has to be looked at so the lock can expire when the day rolls.
   */
  private async accountsToRevalue(): Promise<string[]> {
    const withPositions = await this.db
      .select({ accountId: positionsTable.accountId })
      .from(positionsTable)
      .where(sql`${positionsTable.qty} <> 0`);
    const withOrders = await this.db
      .select({ accountId: ordersTable.accountId })
      .from(ordersTable)
      .where(inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']));
    const locked = await this.db
      .select({ accountId: accounts.id })
      .from(accounts)
      .where(eq(accounts.status, 'LOCKED'));

    // An account that traded yesterday and has been idle since still has a day
    // to close: its trading-day count, its daily limit and an end-of-day
    // trailing drawdown all depend on the roll happening. Selecting on the date
    // itself means each stale account is picked up once and then stops
    // matching, so an idle account costs one evaluation per day rather than
    // one per second.
    const stale = await this.db
      .select({ accountId: accounts.id })
      .from(accounts)
      .where(
        and(
          inArray(accounts.status, ['ACTIVE', 'GOAL_REACHED', 'PASSED', 'LOCKED']),
          or(
            isNull(accounts.currentTradeDate),
            sql`${accounts.currentTradeDate} <> ${this.accountTradingDate()}`,
          ),
        ),
      )
      .limit(200);

    return [
      ...new Set([
        ...withPositions.map((r) => r.accountId),
        ...withOrders.map((r) => r.accountId),
        ...locked.map((r) => r.accountId),
        ...stale.map((r) => r.accountId),
      ]),
    ];
  }

  /**
   * The account's business date, taken from the market rather than the server.
   *
   * An account trades several products whose sessions differ, so one of them
   * has to define the account's day. The equity-index calendar is used: it is
   * the CME business day that every futures account is settled on, and it rolls
   * at 17:00 Chicago like the rest of Globex.
   */
  private accountTradingDate(): string {
    const spec = requireInstrument(ACCOUNT_CALENDAR_SYMBOL);
    // The feed's clock when there is one, so replay and delayed data roll on
    // the day they belong to rather than on the server's calendar. The newest
    // observation across ALL instruments is used rather than the calendar
    // instrument's own: if that one happens to be quiet, the account's day must
    // not silently fall back to the server's date and roll a day that has not
    // happened.
    let newest = 0;
    for (const instrument of listInstruments()) {
      const ts = this.market.getQuote(instrument.root)?.exchangeTs ?? 0;
      if (ts > newest) newest = ts;
    }
    return tradingDate(spec, newest > 0 ? newest : Date.now());
  }

  /** Current valuation of an account, marked to the live market. */
  async valuation(accountId: string): Promise<AccountValuation | null> {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) return null;

    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.accountId, accountId));

    /*
     * `null` means UNKNOWN, and it propagates.
     *
     * One unmarkable position makes the account's open P&L, and therefore its
     * equity, unknown - and an unknown equity is not a number to show, to
     * evaluate rules against, or to raise a high-water mark with.
     */
    let openPnlMicros: number | null = 0;
    let openContracts = 0;
    const views: ReturnType<typeof presentPosition>[] = [];

    for (const row of rows) {
      if (row.qty === 0) continue;
      const spec = requireInstrument(row.symbol);
      const position = toEnginePosition(row, row.symbol);
      const markTicks = this.markTicksFor(spec, row);
      const unrealized = markTicks === null ? null : unrealizedPnlMicros(spec, position, markTicks);
      openPnlMicros = unrealized === null || openPnlMicros === null ? null : openPnlMicros + unrealized;
      openContracts += Math.abs(row.qty);
      views.push(
        presentPosition(position, spec, markTicks, unrealized, {
          stopOrderId: null,
          targetOrderId: null,
        }),
      );
    }

    const equityMicros = openPnlMicros === null ? null : account.balanceMicros + openPnlMicros;

    // Read-only: the rules are evaluated for display here, and enforced under
    // the account lock by `enforceRules`. Reporting and enforcing are the same
    // arithmetic, so the number on screen is the number that will fail you.
    const loaded = await loadAccountAndTemplate(this.db, accountId);
    const config = ruleConfigFor(account, loaded?.template);
    const history = historyFor(account);
    const state = ruleStateFor(account);

    // Unpriceable: report the standing status and no equity figures at all.
    if (openPnlMicros === null || equityMicros === null) {
      return {
        accountId,
        balanceMicros: account.balanceMicros,
        equityMicros: null,
        openPnlMicros: null,
        realizedPnlMicros: account.realizedPnlMicros,
        feesMicros: account.feesMicros,
        dayPnlMicros: null,
        remainingDrawdownMicros: null,
        openContracts,
        positions: views,
        rules: statusFromState(config, state, history),
        unmarkable: await this.unmarkable(accountId),
        at: Date.now(),
      };
    }

    const applied = applyRules(
      config,
      state,
      {
        balanceMicros: account.balanceMicros,
        openPnlMicros,
        equityMicros,
        tradingDate: this.accountTradingDate(),
      },
      history,
    );

    return {
      accountId,
      balanceMicros: account.balanceMicros,
      equityMicros,
      openPnlMicros,
      realizedPnlMicros: account.realizedPnlMicros,
      feesMicros: account.feesMicros,
      dayPnlMicros: applied.status.dayPnlMicros,
      remainingDrawdownMicros: applied.status.remainingDrawdownMicros,
      openContracts,
      positions: views,
      rules: applied.status,
      unmarkable: [],
      at: Date.now(),
    };
  }

  /**
   * Evaluate the programme's rules and act on them.
   *
   * Runs under the account lock, because acting on a breach means canceling
   * orders and closing positions, and those must not interleave with a fill
   * being written by the matcher.
   */
  async enforceRules(accountId: string): Promise<RuleStatus | null> {
    return this.mutex.run(accountId, async () => {
      await this.enforceLocked(accountId);
      return this.readRules(accountId);
    });
  }

  /** The rule status as it now stands, without acting on it. */
  private async readRules(accountId: string): Promise<RuleStatus | null> {
    const valuation = await this.valuation(accountId);
    return valuation?.rules ?? null;
  }

  private async rulesLocked(accountId: string): Promise<RuleStatus | null> {
    const loaded = await loadAccountAndTemplate(this.db, accountId);
    if (!loaded) return null;
    const { account, template } = loaded;

    const config = ruleConfigFor(account, template);
    const state = ruleStateFor(account);
    const openPnlMicros = await this.openPnl(accountId);

    /*
     * An account whose equity is unknown is not evaluated at all.
     *
     * Not "evaluated optimistically", not "evaluated at zero": a drawdown
     * breach and a high-water mark are both statements about equity, and
     * making either from a position nobody can price is how an account ends up
     * permanently damaged by a market it never traded in. The last persisted
     * status stands until the account can be priced again.
     */
    if (openPnlMicros === null) return statusFromState(config, state, historyFor(account));

    const mark = {
      balanceMicros: account.balanceMicros,
      openPnlMicros,
      equityMicros: account.balanceMicros + openPnlMicros,
      tradingDate: this.accountTradingDate(),
    };

    const applied = applyRules(config, state, mark, historyFor(account));

    if (applied.rolledDay) {
      const closed = rollTradingDay(config, state, mark).closed;
      if (closed) await recordClosedDay(this.db, accountId, closed);
    }
    if (applied.changed) {
      await persistRuleState(this.db, accountId, applied.state);
      // Mark-driven rule state (high-water mark, trailing drawdown floor, day
      // roll, breach status/lock) is persisted here without an order event, so
      // the durable projection would otherwise drift until the next fill or a
      // reconcile. Nudge it whenever that state actually changed - guarded by
      // `changed`, so a revaluation that moves nothing enqueues nothing.
      this.enqueueChange(accountId);
    }

    if (applied.newBreach) {
      await this.audit(
        accountId,
        applied.newBreach.status === 'FAILED' ? 'ACCOUNT_FAILED' : 'ACCOUNT_LOCKED',
        null,
        'RISK',
        { rule: applied.newBreach.code },
        { status: state.status },
        { status: applied.state.status, detail: applied.newBreach.detail },
      );
      await this.db.insert(riskEvents).values({
        accountId,
        rule: applied.newBreach.code,
        reasonCode: applied.newBreach.code,
        detail: applied.newBreach.detail as never,
      });

    }

    // Liquidation is retried while a breached account still has exposure, not
    // only on the tick the rule broke. A market that was closed or a feed that
    // was stale when the breach landed must not leave a failed account holding
    // a position forever.
    const breached = applied.state.status === 'FAILED' || applied.state.status === 'LOCKED';
    if (breached && config.flattenOnBreach && (await this.hasExposure(accountId))) {
      await this.liquidateLocked(accountId);
    }

    return applied.status;
  }

  /**
   * Close everything after a breach.
   *
   * Working orders go first: canceling them before the market orders are sent
   * means a resting entry cannot fill into an account that is already over.
   *
   * A liquidation can fail to fill - the market may be closed, or the feed
   * stale - and that is reported rather than papered over. The account stays
   * breached and the position stays open until it can honestly be closed.
   */
  private async liquidateLocked(accountId: string): Promise<void> {
    await this.cancelAllLocked(accountId);

    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, accountId), sql`${positionsTable.qty} <> 0`));

    for (const row of rows) {
      const spec = getInstrument(row.symbol);
      if (!spec) continue;
      try {
        await this.submitLocked({
          accountId,
          userId: null,
          clientOrderId: `liquidate-${randomUUID()}`,
          symbol: spec.root,
          side: row.qty > 0 ? 'SELL' : 'BUY',
          qty: Math.abs(row.qty),
          type: 'MARKET',
          liquidation: true,
        });
      } catch (err) {
        await this.audit(accountId, 'RISK_RULE_TRIGGERED', null, 'RISK', { liquidate: spec.root }, null, {
          failed: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * The practice session a fill belongs to, if one is open.
   *
   * Journalling is a READ of trading state, never a condition on it: a session
   * that fails to resolve leaves the trade unattached rather than blocking it.
   */
  private async currentSessionId(accountId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: practiceSessions.id })
      .from(practiceSessions)
      .where(and(eq(practiceSessions.accountId, accountId), isNull(practiceSessions.endedAt)))
      .orderBy(desc(practiceSessions.startedAt))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Is there anything open on this account?
   *
   * Asked by the replay controls before skipping forward: skipping with a
   * position or a working order would move the market while the trader could
   * not react to it.
   */
  /**
   * Background work the engine started for itself.
   *
   * A market event is handled off the caller's stack: nothing waits for it in
   * production, and it must never take a request down, so failures are
   * swallowed here as before. What is new is that the promises are COUNTED, so
   * a test can ask whether the engine has finished reacting instead of
   * sleeping for a fixed number of milliseconds and hoping.
   */
  private background(work: Promise<unknown>): void {
    const tracked = work.catch((err) => {
      if (process.env['ATLAS_DEBUG_EVENTS']) console.error('engine background work failed', err);
    });
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  /**
   * Resolves when the engine has no background work left.
   *
   * Loops, because reacting to a market event can schedule another match.
   */
  async whenIdle(): Promise<void> {
    for (let pass = 0; pass < 50; pass += 1) {
      if (this.inFlight.size === 0) return;
      await Promise.all([...this.inFlight]);
      // Let any continuation that schedules more work get itself queued.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async openExposure(accountId: string): Promise<boolean> {
    return this.hasExposure(accountId);
  }

  /**
   * Every account of one user that is holding something.
   *
   * Asked before the platform's market data is swapped out from under them:
   * changing the market an open position is priced against is not a display
   * change, it is a change to what the account is worth.
   */
  async accountsWithExposure(userId: string): Promise<
    Array<{
      accountId: string;
      name: string;
      /** The market each open position was opened against. */
      eras: string[];
      workingOrders: number;
    }>
  > {
    const rows = await this.db
      .select({
        accountId: accounts.id,
        name: accounts.name,
        qty: positionsTable.qty,
        era: positionsTable.marketEra,
      })
      .from(accounts)
      .leftJoin(positionsTable, eq(positionsTable.accountId, accounts.id))
      .where(eq(accounts.userId, userId));
    const out = new Map<
      string,
      { accountId: string; name: string; eras: string[]; workingOrders: number }
    >();
    const entry = (accountId: string, name: string) => {
      const existing = out.get(accountId);
      if (existing) return existing;
      const created = { accountId, name, eras: [] as string[], workingOrders: 0 };
      out.set(accountId, created);
      return created;
    };
    for (const row of rows) {
      if ((row.qty ?? 0) === 0) continue;
      // A position saved before eras were recorded has no era. It is treated
      // as belonging to no market, which keeps it on the blocking side.
      entry(row.accountId, row.name).eras.push(row.era ?? '');
    }
    const working = await this.db
      .select({ accountId: ordersTable.accountId, name: accounts.name })
      .from(ordersTable)
      .innerJoin(accounts, eq(accounts.id, ordersTable.accountId))
      .where(
        and(
          eq(accounts.userId, userId),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        ),
      );
    for (const row of working) entry(row.accountId, row.name).workingOrders += 1;
    return [...out.values()];
  }

  /** Anything left that a breach has to close: a position or a working order. */
  private async hasExposure(accountId: string): Promise<boolean> {
    const [position] = await this.db
      .select({ id: positionsTable.id })
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, accountId), sql`${positionsTable.qty} <> 0`))
      .limit(1);
    if (position) return true;
    const [order] = await this.db
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        ),
      )
      .limit(1);
    return Boolean(order);
  }

  /** Unrealized P&L across every open position, marked to the live market. */
  /**
   * Open P&L across an account, or NULL when it cannot be known.
   *
   * Null when a position has no mark that applies to it - which is the case
   * while the platform is serving a different market from the one the position
   * was opened against. Returning zero there would say "this position is
   * flat", which is a different and false statement.
   */
  private async openPnl(accountId: string): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.accountId, accountId));
    let total = 0;
    for (const row of rows) {
      if (row.qty === 0) continue;
      const spec = getInstrument(row.symbol);
      if (!spec) continue;
      const markTicks = this.markTicksFor(spec, row);
      if (markTicks === null) return null;
      total += unrealizedPnlMicros(spec, toEnginePosition(row, row.symbol), markTicks);
    }
    return total;
  }

  /** The open positions whose market is not the one now being served. */
  private async unmarkable(
    accountId: string,
  ): Promise<Array<{ symbol: string; openedAgainst: string; nowServing: string }>> {
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, accountId), sql`${positionsTable.qty} <> 0`));
    const era = this.market.era();
    return rows
      .filter((row) => row.marketEra !== null && row.marketEra !== era)
      .map((row) => ({ symbol: row.symbol, openedAgainst: row.marketEra!, nowServing: era }));
  }

  stop(): void {
    this.marketUnsubscribe?.();
    this.marketUnsubscribe = null;
    if (this.valuationTimer) clearInterval(this.valuationTimer);
    this.valuationTimer = null;
    for (const timer of this.pendingWakes) clearTimeout(timer);
    this.pendingWakes.clear();
  }

  /**
   * Re-evaluate an account once its newly submitted order becomes eligible.
   *
   * Without this, an order is only ever matched when a market event arrives, so
   * the effective delay on a market order is `max(latency, time to next tick)`.
   * On a feed that polls every five seconds that turns a 250ms latency setting
   * into a five second wait, and a trader pressing Flatten watches nothing
   * happen. The wake-up matches against the CURRENT quote — it invents no data,
   * it just stops the engine sleeping through its own latency window.
   */
  private scheduleEligibilityWake(accountId: string, symbol: string, eligibleAt: number): void {
    // Only live: in a replay the clock is the recording's, and it advances when
    // the next event does. A wall-clock timer there would fire against a market
    // that has not moved, and at 100x it would fire far too late anyway.
    if (this.market.isReplay()) return;
    const delay = eligibleAt - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      this.pendingWakes.delete(timer);
      this.background(this.runMatch(accountId, symbol));
    }, delay + 5);
    timer.unref?.();
    this.pendingWakes.add(timer);
  }

  /** Which accounts have exposure in a symbol, so events are not broadcast. */
  private async refreshActiveSymbols(): Promise<void> {
    this.activeSymbols.clear();
    const openOrders = await this.db
      .select({ accountId: ordersTable.accountId, symbol: ordersTable.symbol })
      .from(ordersTable)
      .where(inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']));
    const openPositions = await this.db
      .select({ accountId: positionsTable.accountId, symbol: positionsTable.symbol })
      .from(positionsTable)
      .where(sql`${positionsTable.qty} <> 0`);

    for (const row of [...openOrders, ...openPositions]) this.track(row.accountId, row.symbol);
  }

  private track(accountId: string, symbol: string): void {
    let set = this.activeSymbols.get(symbol);
    if (!set) {
      set = new Set();
      this.activeSymbols.set(symbol, set);
    }
    set.add(accountId);
  }

  private pathKey(accountId: string, symbol: string): string {
    return `${accountId}|${symbol}`;
  }

  /**
   * Fold one genuine observation into every exposed account's path.
   *
   * Synchronous and allocation-light: it runs on the market thread for every
   * print, so it does no I/O and touches nothing that can await.
   */
  private observePrice(symbol: string, price: number): void {
    const spec = getInstrument(symbol);
    if (!spec) return;
    const accountIds = this.activeSymbols.get(spec.root);
    if (!accountIds || accountIds.size === 0) return;

    const ticks = priceToTicks(spec, price);
    for (const accountId of accountIds) {
      const key = this.pathKey(accountId, spec.root);
      const path = this.livePath.get(key);
      if (!path) {
        this.livePath.set(key, { minTicks: ticks, maxTicks: ticks });
        continue;
      }
      if (ticks < path.minTicks) path.minTicks = ticks;
      if (ticks > path.maxTicks) path.maxTicks = ticks;
    }
  }

  /**
   * Take the prices observed since the last pass, and clear the buffer.
   *
   * Draining rather than reading is what makes the excursions reproducible. The
   * buffer is a mutable object that every arriving print writes into, so a pass
   * that read it after an await would see prints belonging to observations it
   * has not matched yet - and a trade could record a low the market only
   * reached after it had closed. Each drain is taken synchronously, in event
   * order, and the window it returns is folded into the stored running extreme,
   * so nothing is double counted and nothing is lost.
   */
  private drainPath(accountId: string, symbol: string): PriceWindow | null {
    const key = this.pathKey(accountId, symbol);
    const window = this.livePath.get(key);
    if (!window) return null;
    this.livePath.delete(key);
    return { minTicks: window.minTicks, maxTicks: window.maxTicks };
  }

  private async onMarketEvent(symbol: string, observed: MarketSnapshot | null): Promise<void> {
    const accountIds = this.activeSymbols.get(symbol);
    if (!accountIds || accountIds.size === 0) return;

    // Every account's pass is DECIDED and its price window DRAINED before any
    // of them runs. Doing it inside the loop would make the boundary between
    // one pass's prices and the next's depend on how long another account's
    // match took, which is not a property of the market.
    const passes: Array<{ accountId: string; key: string; window: PriceWindow | null }> = [];
    for (const accountId of [...accountIds]) {
      const key = `${accountId}|${symbol}`;
      // A match reads the CURRENT market, so two queued matches for the same
      // account and symbol do the same work twice. Collapsing them keeps a
      // burst of market events from building a queue that every later order,
      // cancel or flatten has to wait behind. The flag is cleared as the task
      // starts, not when it finishes, so an event arriving mid-match still
      // earns a fresh pass over the new data.
      //
      // An account with a WORKING order is exempt: for it, each observation is
      // a chance to fill, and collapsing two of them would silently skip a
      // price the market actually traded.
      //
      // A REPLAY is exempt unconditionally, queue depth included. Whether two
      // events collapse depends on how fast the machine happened to be, so any
      // dropped observation makes the session unrepeatable - a different fill,
      // a different excursion, a different trade from the same recording and
      // the same actions. A replay is a bounded, self-paced stream rather than
      // a live feed that can burst without limit, so it is matched in full and
      // simply takes as long as it takes.
      const exempt =
        this.market.isReplay() ||
        (this.working.has(key) && this.mutex.depthOf(accountId) < MAX_QUEUED_MATCHES);
      if (!exempt && this.pendingMatches.has(key)) continue;
      this.pendingMatches.add(key);
      passes.push({ accountId, key, window: this.drainPath(accountId, symbol) });
    }

    // See MatchPass.observed: pinned in a replay, freshest live.
    const pinned = this.market.isReplay() ? observed : null;
    for (const pass of passes) {
      await this.mutex.run(pass.accountId, () => {
        this.pendingMatches.delete(pass.key);
        return this.matchLocked(pass.accountId, symbol, { observed: pinned, window: pass.window });
      });
    }
  }

  // -- market snapshot -----------------------------------------------------

  private snapshotFor(spec: InstrumentSpec): MarketSnapshot | null {
    const quote = this.market.getQuote(spec.root);
    if (!quote) return null;
    const toTicks = (p: number | null): number | null =>
      p === null ? null : priceToTicks(spec, p);

    const bar = this.market.lastClosedBar(spec.root);
    return {
      symbol: spec.root,
      exchangeTs: quote.exchangeTs,
      lastTicks: toTicks(quote.last),
      bidTicks: toTicks(quote.bid),
      askTicks: toTicks(quote.ask),
      bar:
        bar === null
          ? null
          : {
              startTs: bar.time,
              endTs: bar.time + this.market.baseBarMs(spec.root),
              openTicks: priceToTicks(spec, bar.open),
              highTicks: priceToTicks(spec, bar.high),
              lowTicks: priceToTicks(spec, bar.low),
              closeTicks: priceToTicks(spec, bar.close),
              volume: bar.volume,
            },
    };
  }

  // -- public operations ---------------------------------------------------

  /**
   * Best-effort projection nudge for an operation whose change may not go
   * through the fill transaction (a resting limit, a cancel). Fire-and-forget on
   * the pool: the consumer recomputes from authority, so a missed nudge is
   * self-healed by the next event or by reconciliation - it never corrupts.
   */
  private enqueueChange(accountId: string): void {
    void enqueueOutbox(this.db, {
      aggregateId: accountId,
      type: 'account.changed',
      payload: { reason: 'order' },
    }).catch(() => undefined);
  }

  async submitOrder(input: SubmitOrderInput): Promise<EngineChange> {
    const change = await this.mutex.run(input.accountId, () => this.submitLocked(input));
    this.enqueueChange(input.accountId);
    return change;
  }

  async modifyOrder(
    accountId: string,
    orderId: string,
    patch: { qty?: number; limitTicks?: number | null; stopTicks?: number | null; trailTicks?: number | null },
    expectedVersion?: number,
  ): Promise<EngineChange> {
    const change = await this.mutex.run(accountId, () => this.modifyLocked(accountId, orderId, patch, expectedVersion));
    this.enqueueChange(accountId);
    return change;
  }

  async cancelOrder(accountId: string, orderId: string): Promise<EngineChange> {
    const change = await this.mutex.run(accountId, () => this.cancelLocked(accountId, orderId));
    this.enqueueChange(accountId);
    return change;
  }

  async cancelAll(accountId: string, symbol?: string): Promise<EngineChange> {
    const change = await this.mutex.run(accountId, () => this.cancelAllLocked(accountId, symbol));
    this.enqueueChange(accountId);
    return change;
  }

  /** Close a position at market. */
  async flatten(accountId: string, userId: string, symbol: string): Promise<EngineChange> {
    const change = await this.mutex.run(accountId, async () => {
      const spec = requireInstrument(symbol);
      const position = await this.loadPosition(accountId, spec.root);
      if (position.qty === 0) return this.emptyChange(accountId);
      await this.cancelProtectiveLocked(accountId, spec.root);
      return this.submitLocked({
        accountId,
        userId,
        clientOrderId: `flatten-${randomUUID()}`,
        symbol: spec.root,
        side: position.qty > 0 ? 'SELL' : 'BUY',
        qty: Math.abs(position.qty),
        type: 'MARKET',
      });
    });
    this.enqueueChange(accountId);
    return change;
  }

  /** Flip a position to the same size on the other side. */
  async reverse(accountId: string, userId: string, symbol: string): Promise<EngineChange> {
    const change = await this.mutex.run(accountId, async () => {
      const spec = requireInstrument(symbol);
      const position = await this.loadPosition(accountId, spec.root);
      if (position.qty === 0) return this.emptyChange(accountId);
      await this.cancelProtectiveLocked(accountId, spec.root);
      return this.submitLocked({
        accountId,
        userId,
        clientOrderId: `reverse-${randomUUID()}`,
        symbol: spec.root,
        side: position.qty > 0 ? 'SELL' : 'BUY',
        qty: Math.abs(position.qty) * 2,
        type: 'MARKET',
      });
    });
    this.enqueueChange(accountId);
    return change;
  }

  /**
   * Attach, move or remove the protective orders of an OPEN position.
   *
   * This is the other half of the bracket workflow. A bracket submitted with an
   * entry is a plan made before the trade exists; this is protection added to a
   * trade that already does - which is how a trader who took a position at
   * market and then decided where the risk should sit actually works.
   *
   * The orders it creates are ordinary working orders in an OCO pair: sized to
   * the position, resized when the position changes, canceled when it closes,
   * and executed by the same matcher as everything else. Dragging one on the
   * chart modifies THIS, not a picture of it.
   */
  async setProtection(
    accountId: string,
    userId: string | null,
    symbol: string,
    levels: ProtectionLevels,
  ): Promise<EngineChange> {
    const change = await this.mutex.run(accountId, () => this.setProtectionLocked(accountId, userId, symbol, levels));
    this.enqueueChange(accountId);
    return change;
  }

  /**
   * The clock the matcher measures latency against.
   *
   * Live, it is the wall clock: the feed's own sampling is the dominant delay
   * and an order must not wait for a poll that may be seconds away. In a
   * REPLAY it is the market's clock, which makes a replayed session
   * reproducible - the same data, settings and actions produce the same fills,
   * however fast it was played - and makes a latency setting mean the same
   * thing at 1x and at 100x.
   */
  private eligibilityClock(snapshot: MarketSnapshot | null): number {
    if (!this.market.isReplay()) return Date.now();
    return snapshot?.exchangeTs ?? Date.now();
  }

  /** Serialized work queued or running for one account. Diagnostics only. */
  queueDepth(accountId: string): number {
    return this.mutex.depthOf(accountId);
  }

  /** Run the matcher for one account and symbol against the current market. */
  async runMatch(accountId: string, symbol: string): Promise<EngineChange> {
    return this.mutex.run(accountId, () => this.matchLocked(accountId, symbol));
  }

  // -- locked implementations ---------------------------------------------

  private emptyChange(accountId: string): EngineChange {
    return {
      accountId,
      seq: 0,
      orders: [],
      position: null,
      fills: [],
      trades: [],
      balanceMicros: 0,
    };
  }

  private async loadPosition(accountId: string, symbol: string): Promise<PositionState> {
    const [row] = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, accountId), eq(positionsTable.symbol, symbol)));
    return toEnginePosition(row, symbol);
  }

  private async loadEnvironment(accountId: string): Promise<SimulationEnvironment> {
    const [row] = await this.db
      .select({ env: accounts.simulationEnvironment })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return normalizeEnvironment((row?.env ?? null) as Partial<SimulationEnvironment> | null);
  }

  private async submitLocked(input: SubmitOrderInput): Promise<EngineChange> {
    const spec = requireInstrument(input.symbol);
    const env = await this.loadEnvironment(input.accountId);
    const now = Date.now();

    // Idempotency: the same client order id must never create two orders.
    const [existing] = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, input.accountId),
          eq(ordersTable.clientOrderId, input.clientOrderId),
        ),
      );
    if (existing) {
      return this.buildChange(input.accountId, spec, [toEngineOrder(existing)], [], []);
    }

    /*
     * An order must never be priced against a market the position was not
     * opened in.
     *
     * Filling here would realise a fabricated profit or loss into the
     * account's balance - the one number a trader can never get back. This
     * cannot normally be reached, because switching the platform's market is
     * refused while anything is open; it is the backstop for a position left
     * in that state by an earlier build.
     */
    const [existingPosition] = await this.db
      .select({ era: positionsTable.marketEra, qty: positionsTable.qty })
      .from(positionsTable)
      .where(
        and(eq(positionsTable.accountId, input.accountId), eq(positionsTable.symbol, spec.root)),
      );
    if (
      existingPosition &&
      existingPosition.qty !== 0 &&
      existingPosition.era !== null &&
      existingPosition.era !== this.market.era()
    ) {
      throw new OrderRejectedError(
        'POSITION_FROM_ANOTHER_MARKET',
        `This ${spec.root} position was opened against ${existingPosition.era} and the platform is serving ${this.market.era()}. Switch back to manage it.`,
      );
    }

    const account = await this.loadRiskAccount(input.accountId);
    const position = await this.loadPosition(input.accountId, spec.root);
    const openContracts = await this.openContractWeight(input.accountId, account.microsCountAsFraction);
    const snapshot = this.snapshotFor(spec);
    const freshness = this.market.freshness(spec.root);

    const rejection = checkOrder(
      {
        account,
        spec,
        freshness,
        position,
        openContracts,
        lastTicks: snapshot?.lastTicks ?? null,
        // The feed's own clock decides whether the market was open, so replay
        // and delayed data are judged against the session they belong to.
        marketNow: snapshot?.exchangeTs ?? now,
        now,
      },
      {
        side: input.side,
        qty: input.qty,
        type: input.type,
        limitTicks: input.limitTicks ?? null,
        stopTicks: input.stopTicks ?? null,
        liquidation: input.liquidation ?? false,
      },
    );

    if (rejection) {
      await this.recordRisk(input.accountId, null, rejection);
      throw new OrderRejectedError(rejection.reason, rejection.message, rejection.detail);
    }

    const entry = createOrder(
      {
        id: randomUUID(),
        accountId: input.accountId,
        clientOrderId: input.clientOrderId,
        symbol: spec.root,
        side: input.side,
        qty: input.qty,
        type: input.type,
        limitTicks: input.limitTicks ?? null,
        stopTicks: input.stopTicks ?? null,
        tif: input.tif ?? 'DAY',
        trailTicks: input.trailTicks ?? null,
        bracketRole: input.bracket ? 'ENTRY' : 'STANDALONE',
        // The DAY in "day order" is the market's day. On a delayed feed or a
        // replay the server's clock can already be on the next session while
        // the market the order is going into is still on this one.
        tradingDate: tradingDate(spec, snapshot?.exchangeTs ?? now),
        now,
        // Where the order sits in MARKET time, which is what decides which
        // bars are allowed to fill it.
        marketTs: snapshot?.exchangeTs ?? null,
        eligibleAt: this.eligibilityClock(snapshot) + env.latencyMs,
      },
      env,
    );

    await this.db.insert(ordersTable).values({
      ...toOrderValues(entry),
      bracketConfig: (input.bracket ?? null) as never,
      // The contract this order intends, resolved at its market time. Null for a
      // root that cannot be resolved - never a wrong contract.
      contractCode: contractResolver.contractCode(spec.root, snapshot?.exchangeTs ?? now),
    });
    this.track(input.accountId, spec.root);
    // Optimistic: the order exists from this moment, so the next observation
    // must not be coalesced away before the matcher has seen it.
    this.working.add(`${input.accountId}|${spec.root}`);
    await this.audit(input.accountId, 'ORDER_SUBMITTED', input.userId, 'USER', input, null, entry);

    // Evaluate immediately: a market order should not wait for the next tick.
    const change = await this.matchLocked(input.accountId, spec.root);

    // Still unfilled only because its latency has not elapsed? Come back for it
    // rather than waiting on the feed's next poll.
    const submitted = change.orders.find((o) => o.id === entry.id);
    if (submitted && (submitted.status === 'WORKING' || submitted.status === 'PARTIALLY_FILLED')) {
      this.scheduleEligibilityWake(input.accountId, spec.root, entry.eligibleAt);
    }
    return change;
  }

  private async modifyLocked(
    accountId: string,
    orderId: string,
    patch: { qty?: number; limitTicks?: number | null; stopTicks?: number | null; trailTicks?: number | null },
    expectedVersion?: number,
  ): Promise<EngineChange> {
    const [row] = await this.db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.accountId, accountId)));
    if (!row) throw new OrderRejectedError('ORDER_NOT_FOUND', 'No such order.');

    const order = toEngineOrder(row);
    // Optimistic concurrency: a drag that started before a fill must not win.
    if (expectedVersion !== undefined && expectedVersion !== order.version) {
      throw new OrderRejectedError(
        'STALE_ORDER_VERSION',
        'The order changed while you were modifying it. Refresh and try again.',
        { expectedVersion, actualVersion: order.version },
      );
    }

    const spec = requireInstrument(order.symbol);
    const result = modifyOrder(order, patch, Date.now());
    if (!result.ok) {
      throw new OrderRejectedError('ORDER_NOT_MODIFIABLE', describeModifyFailure(result.reason));
    }

    await this.db
      .update(ordersTable)
      .set(toOrderValues(result.order))
      .where(eq(ordersTable.id, orderId));
    await this.audit(accountId, 'ORDER_MODIFIED', null, 'USER', patch, order, result.order);

    return this.matchLocked(accountId, spec.root);
  }

  private async cancelLocked(accountId: string, orderId: string): Promise<EngineChange> {
    const [row] = await this.db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.accountId, accountId)));
    if (!row) throw new OrderRejectedError('ORDER_NOT_FOUND', 'No such order.');

    const order = toEngineOrder(row);
    if (!isOpen(order)) {
      throw new OrderRejectedError('ORDER_NOT_MODIFIABLE', `Order is already ${order.status}.`);
    }

    const canceled: EngineOrder = {
      ...order,
      status: 'CANCELED',
      version: order.version + 1,
      updatedAt: Date.now(),
    };
    await this.db.update(ordersTable).set(toOrderValues(canceled)).where(eq(ordersTable.id, orderId));
    await this.audit(accountId, 'ORDER_CANCELED', null, 'USER', { orderId }, order, canceled);

    const spec = requireInstrument(order.symbol);
    return this.buildChange(accountId, spec, [canceled], [], []);
  }

  private async cancelAllLocked(accountId: string, symbol?: string): Promise<EngineChange> {
    const where = symbol
      ? and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, symbol),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        )
      : and(
          eq(ordersTable.accountId, accountId),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        );

    const rows = await this.db.select().from(ordersTable).where(where);
    const now = Date.now();
    const canceled: EngineOrder[] = [];
    for (const row of rows) {
      const order = toEngineOrder(row);
      const next: EngineOrder = { ...order, status: 'CANCELED', version: order.version + 1, updatedAt: now };
      await this.db.update(ordersTable).set(toOrderValues(next)).where(eq(ordersTable.id, order.id));
      canceled.push(next);
    }
    if (canceled.length > 0) {
      await this.audit(accountId, 'ORDER_CANCELED', null, 'USER', { symbol, count: canceled.length }, null, null);
    }
    const spec = requireInstrument(symbol ?? canceled[0]?.symbol ?? 'NQ');
    return this.buildChange(accountId, spec, canceled, [], []);
  }

  /** Cancel a symbol's protective orders, so flatten/reverse do not double-exit. */
  private async cancelProtectiveLocked(accountId: string, symbol: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, symbol),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
          inArray(ordersTable.bracketRole, ['STOP_LOSS', 'TAKE_PROFIT']),
        ),
      );
    const now = Date.now();
    for (const row of rows) {
      const order = toEngineOrder(row);
      await this.db
        .update(ordersTable)
        .set(toOrderValues({ ...order, status: 'CANCELED', version: order.version + 1, updatedAt: now }))
        .where(eq(ordersTable.id, order.id));
    }
  }

  /**
   * The heart of the engine.
   *
   * Loads the account's open orders and position, runs the pure matcher against
   * the current market, and persists everything in ONE transaction. An OCO
   * sibling cannot survive its partner's fill, because both writes land or
   * neither does.
   */
  private async matchLocked(
    accountId: string,
    symbol: string,
    pass?: MatchPass,
  ): Promise<EngineChange> {
    const spec = requireInstrument(symbol);
    // The observation this pass is matching. A market-event pass carries the
    // one it was triggered by; a valuation tick or an explicit re-match reads
    // the market as it stands, which for those callers IS the observation.
    const snapshot = pass?.observed ?? this.snapshotFor(spec);
    const window = pass ? pass.window : this.drainPath(accountId, spec.root);
    const markTicks = snapshot?.lastTicks ?? null;
    const env = await this.loadEnvironment(accountId);

    const openRows = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, spec.root),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        ),
      );
    const openOrders = openRows.map(toEngineOrder);
    const key = `${accountId}|${spec.root}`;
    const position = await this.loadPosition(accountId, spec.root);

    if (!snapshot || openOrders.length === 0) {
      // Nothing to match, but the mark still moved: an account holding a
      // position can breach its drawdown without a single order being working,
      // and waiting for the next valuation tick to notice would hand the trader
      // a second of trading on an account that is already over.
      this.working.delete(key);
      if (position.qty !== 0) {
        // The excursions are a record of the PATH, so they are updated on every
        // mark - including the ones that fill nothing, which is most of them.
        await this.trackExcursion(accountId, spec, window, markTicks);
        await this.enforceLocked(accountId);
      }
      return this.buildChange(accountId, spec, openOrders, [], [], position);
    }

    const result = matchOrders(
      { spec, env, market: snapshot, now: this.eligibilityClock(snapshot) },
      openOrders,
      position,
    );

    const changedOrders = result.orders.filter((o) => {
      const before = openOrders.find((x) => x.id === o.id);
      return !before || orderChanged(before, o);
    });

    const executionRows: EngineChange['fills'] = [];
    const tradeRows: Array<Record<string, unknown>> = [];

    // The excursions belong to the position as it was BEFORE this fill closed
    // part of it, including whatever this very observation did to it: a trade
    // stopped out at its low took that excursion on its way there.
    const excursion = await this.excursionContext(
      accountId,
      spec,
      position,
      result.position,
      window,
      markTicks,
    );
    const sessionId = await this.currentSessionId(accountId);

    if (result.fills.length > 0 || changedOrders.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const order of changedOrders) {
          await tx.update(ordersTable).set(toOrderValues(order)).where(eq(ordersTable.id, order.id));
        }

        // Position
        await tx
          .insert(positionsTable)
          .values({
            ...toPositionValues(accountId, result.position),
            // The market these fills were priced against. Cleared when the
            // position goes flat: there is nothing left to mark.
            marketEra: result.position.qty === 0 ? null : this.market.era(),
            // The actual tradeable contract this position opened in, resolved at
            // the fill instant. Cleared when flat; on a subsequent add it is
            // preserved (below), never re-resolved to a later front month - the
            // open-position contract lock.
            contractCode:
              result.position.qty === 0
                ? null
                : contractResolver.contractCode(spec.root, snapshot.exchangeTs),
            // A position that has just gone flat, or flipped, starts its
            // excursions again: they describe ONE holding, not an account.
            maeMicros: result.position.qty === 0 ? 0 : Math.round(excursion.maePerContract),
            mfeMicros: result.position.qty === 0 ? 0 : Math.round(excursion.mfePerContract),
            initialRiskMicros:
              result.position.qty === 0 || excursion.riskPerContract === null
                ? null
                : Math.round(excursion.riskPerContract),
          })
          .onConflictDoUpdate({
            target: [positionsTable.accountId, positionsTable.symbol],
            set: {
              side: sql`excluded.side`,
              qty: sql`excluded.qty`,
              costBasisMicros: sql`excluded.cost_basis_micros`,
              realizedPnlMicros: sql`excluded.realized_pnl_micros`,
              feesMicros: sql`excluded.fees_micros`,
              marketEra: sql`excluded.market_era`,
              // The lock: clear on flat, otherwise KEEP the contract this
              // position was opened in (adopt the freshly-resolved one only when
              // there was none, e.g. a legacy row). A subsequent fill on the
              // root never migrates an open position to a new front month.
              contractCode: sql`case when excluded.qty = 0 then null else coalesce(${positionsTable.contractCode}, excluded.contract_code) end`,
              maeMicros: sql`excluded.mae_micros`,
              mfeMicros: sql`excluded.mfe_micros`,
              initialRiskMicros: sql`excluded.initial_risk_micros`,
              openedAt: sql`excluded.opened_at`,
              updatedAt: sql`excluded.updated_at`,
              version: sql`${positionsTable.version} + 1`,
            },
          });

        // Executions
        let seq = await this.nextSeq(tx, accountId, result.fills.length);
        for (const fill of result.fills) {
          const order = result.orders.find((o) => o.id === fill.orderId)!;
          const id = randomUUID();
          await tx.insert(executions).values({
            id,
            orderId: fill.orderId,
            accountId,
            symbol: spec.root,
            // The specific contract this fill happened in, resolved at fill time.
            contractCode: contractResolver.contractCode(spec.root, fill.exchangeTs),
            side: order.side,
            qty: fill.qty,
            priceTicks: fill.priceTicks,
            feesMicros: fill.feesMicros,
            realizedPnlMicros: 0,
            slippageTicks: fill.slippageTicks,
            liquidity: fill.liquidity,
            execTime: new Date(fill.exchangeTs),
            seq: seq++,
          });
          executionRows.push({
            id,
            orderId: fill.orderId,
            symbol: spec.root,
            side: order.side,
            qty: fill.qty,
            priceTicks: fill.priceTicks,
            feesMicros: fill.feesMicros,
            realizedPnlMicros: 0,
            execTime: fill.exchangeTs,
          });
        }

        /*
         * Closed round-trips, with the fees for the WHOLE round turn.
         *
         * The row used to carry only the closing side's fees, while the
         * account had been charged on the way in as well. Every trade in the
         * journal therefore looked better than it was, and the sum of the
         * journal's net P&L never matched the account's realized change - by
         * exactly the entry commission, on every trade.
         *
         * The entry side is taken from the position as it stood BEFORE this
         * fill: its accumulated fees are what was paid to open the quantity
         * being closed now, so a partial close pays its share and no more.
         */
        const openQtyBefore = Math.abs(position.qty);
        const entryFeePerContract = openQtyBefore === 0 ? 0 : position.feesMicros / openQtyBefore;
        const closedQty = result.closedLots.reduce((sum, lot) => sum + lot.qty, 0);

        for (const lot of result.closedLots) {
          const exitShare =
            closedQty === 0 ? 0 : Math.round((result.feesMicros * lot.qty) / closedQty);
          const roundTurnFees = Math.round(entryFeePerContract * lot.qty) + exitShare;
          const row = this.tradeRow(accountId, spec, lot, roundTurnFees, excursion, sessionId);
          await tx.insert(trades).values(row as never);
          tradeRows.push(row as Record<string, unknown>);
        }

        // Account balance: realized P&L less fees, settled immediately.
        if (result.realizedPnlMicros !== 0 || result.feesMicros !== 0) {
          await tx
            .update(accounts)
            .set({
              realizedPnlMicros: sql`${accounts.realizedPnlMicros} + ${result.realizedPnlMicros}`,
              feesMicros: sql`${accounts.feesMicros} + ${result.feesMicros}`,
              balanceMicros: sql`${accounts.balanceMicros} + ${result.realizedPnlMicros - result.feesMicros}`,
              updatedAt: new Date(),
            })
            .where(eq(accounts.id, accountId));
        }

        // Transactional outbox: a fill enqueues an account-changed event in the
        // SAME transaction, so the projection/fan-out event exists whenever the
        // fill committed. The consumer recomputes from authority, so the exact
        // version here is informational, not load-bearing.
        await enqueueOutbox(tx as unknown as Database, {
          aggregateId: accountId,
          type: 'account.changed',
          payload: { reason: 'fill' },
        });
      });
    }

    // Brackets are attached once the entry has actually filled, on whichever
    // pass fills it. A stop protecting a position that does not exist is how an
    // account ends up short by accident, so this never runs ahead of the fill.
    //
    // A failure here must not fail the whole call: the entry has already filled
    // and been persisted, and reporting an error would leave the trader
    // believing they have no position when they do.
    try {
      await this.syncBrackets(accountId, spec, env);
      await this.syncProtection(accountId, spec);
    } catch (err) {
      await this.audit(accountId, 'RISK_RULE_TRIGGERED', null, 'ENGINE', { bracketSyncFailed: true }, null, {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // What is STILL working after this pass decides whether the next
    // observation may be coalesced. Reading it from the result rather than from
    // what was loaded means an order that just filled stops exempting the
    // account immediately.
    if (result.orders.some((order) => isOpen(order))) this.working.add(key);
    else this.working.delete(key);

    if (result.position.qty !== 0) await this.trackExcursion(accountId, spec, window, markTicks);

    // The rules see every fill before anyone else does. A drawdown breached by
    // this fill has to close the account NOW, not on the next valuation tick,
    // or the trader gets a second's worth of trading on an account that is
    // already over.
    await this.enforceLocked(accountId);

    const finalOrders = await this.loadOpenAndRecent(accountId, spec.root);
    const change = await this.buildChange(
      accountId,
      spec,
      finalOrders,
      executionRows,
      tradeRows,
      result.position,
    );
    this.emit(change);

    // Revalue at once so a fill is reflected without waiting for the next tick
    // of the valuation timer.
    const valuation = await this.valuation(accountId);
    if (valuation) for (const listener of this.valuationListeners) listener(valuation);

    return change;
  }

  /**
   * Run the rules from inside a section that already holds the account lock.
   *
   * Re-entrant by design: enforcing a breach liquidates, liquidating fills, and
   * a fill runs the rules again. The guard stops that becoming a loop; the
   * outermost call is the one that matters, and the state it reads already
   * includes everything the inner fills did.
   */
  private async enforceLocked(accountId: string): Promise<void> {
    if (this.enforcing.has(accountId)) return;
    this.enforcing.add(accountId);
    try {
      await this.rulesLocked(accountId);
    } finally {
      this.enforcing.delete(accountId);
    }
  }

  /**
   * One closed trade, as the journal records it.
   *
   * The excursions and the risk are carried PER CONTRACT on the position and
   * multiplied by the quantity closed here. Measured that way they are a
   * property of the price path rather than of the size, so closing three lots
   * in three pieces produces three trades whose figures add up to the one a
   * single exit would have produced.
   */
  private tradeRow(
    accountId: string,
    spec: InstrumentSpec,
    lot: ClosedLot,
    feesMicros: number,
    excursion: { maePerContract: number; mfePerContract: number; riskPerContract: number | null },
    sessionId: string | null,
  ): Record<string, unknown> {
    return {
      accountId,
      symbol: spec.root,
      // The contract this round-trip traded, resolved at the entry instant so a
      // trade is always attributed to the contract it opened in.
      contractCode: contractResolver.contractCode(spec.root, lot.openedAt ?? lot.closedAt),
      side: lot.side,
      qty: lot.qty,
      entryTicksScaled: scaleTicks(lot.entryTicks),
      exitTicksScaled: scaleTicks(lot.exitTicks),
      entryTime: new Date(lot.openedAt ?? lot.closedAt),
      exitTime: new Date(lot.closedAt),
      grossPnlMicros: lot.grossPnlMicros,
      feesMicros,
      netPnlMicros: lot.grossPnlMicros - feesMicros,
      maeMicros: Math.round(excursion.maePerContract * lot.qty),
      mfeMicros: Math.round(excursion.mfePerContract * lot.qty),
      initialRiskMicros:
        excursion.riskPerContract === null
          ? null
          : Math.round(excursion.riskPerContract * lot.qty),
      sessionId,
      tradeDate: tradingDate(spec, lot.closedAt),
    };
  }

  /**
   * The excursion figures a fill should be recorded with.
   *
   * It takes the position as it stood before the fill, marks it against this
   * observation, and folds that into the stored running extremes - so a trade
   * that was stopped out at the low of its move records that low, rather than
   * the last mark before it.
   */
  private async excursionContext(
    accountId: string,
    spec: InstrumentSpec,
    before: PositionState,
    after: PositionState,
    window: PriceWindow | null,
    markTicks: number | null,
  ): Promise<{ maePerContract: number; mfePerContract: number; riskPerContract: number | null }> {
    const [row] = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, accountId), eq(positionsTable.symbol, spec.root)));

    // A position opening from flat starts clean, whatever the old row holds.
    // The drained window belongs to the market BEFORE the position existed, so
    // it is discarded: the path starts at the price the position opened at.
    const opening = before.qty === 0 && after.qty !== 0;
    let mae = opening ? 0 : (row?.maeMicros ?? 0);
    let mfe = opening ? 0 : (row?.mfeMicros ?? 0);

    const reach = opening
      ? this.reachFrom(spec, after, null, markTicks)
      : this.reachFrom(spec, before, window, markTicks);
    if (reach !== null) {
      mae = Math.round(Math.min(mae, reach.worst));
      mfe = Math.round(Math.max(mfe, reach.best));
    }

    const rawRisk = opening
      ? await this.protectiveRisk(accountId, spec, after)
      : (row?.initialRiskMicros ?? (await this.protectiveRisk(accountId, spec, before)));

    return {
      maePerContract: mae,
      mfePerContract: mfe,
      riskPerContract: rawRisk === null ? null : Math.round(rawRisk),
    };
  }

  /**
   * How far the open position has travelled, per contract.
   *
   * Excursion is a price fact: the distance between the average entry and the
   * furthest the market went while the position was held. Recording it per
   * contract keeps it a property of the path rather than of the size, and keeps
   * it exact when a position is closed in pieces.
   */
  /**
   * The best and worst this position has been since it was last marked.
   *
   * Taken from every price observed in between rather than only the newest, so
   * the figure does not depend on which observations happened to arrive while
   * the engine was busy.
   */
  private reachFrom(
    spec: InstrumentSpec,
    position: PositionState,
    window: PriceWindow | null,
    markTicks: number | null,
  ): { worst: number; best: number } | null {
    if (position.qty === 0) return null;

    const candidates: number[] = [];
    if (window) candidates.push(window.minTicks, window.maxTicks);
    if (markTicks !== null) candidates.push(markTicks);
    if (candidates.length === 0) return null;

    const excursions = candidates
      .map((ticks) => this.excursionFor(spec, position, ticks))
      .filter((value): value is number => value !== null);
    if (excursions.length === 0) return null;

    return { worst: Math.min(...excursions), best: Math.max(...excursions) };
  }

  private excursionFor(
    spec: InstrumentSpec,
    position: PositionState,
    markTicks: number | null,
  ): number | null {
    if (position.qty === 0 || markTicks === null) return null;
    const avgEntryTicks = position.costBasisMicros / (position.qty * spec.tickValueMicros);
    const direction = position.qty > 0 ? 1 : -1;
    return (markTicks - avgEntryTicks) * direction * spec.tickValueMicros;
  }

  /**
   * Update the running excursions, and freeze the risk the position was taken
   * with the first time a protective stop is seen behind it.
   *
   * Called on every mark, so the figures come from genuine observations and not
   * from a reconstruction after the fact.
   */
  private async trackExcursion(
    accountId: string,
    spec: InstrumentSpec,
    window: PriceWindow | null,
    markTicks: number | null,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(positionsTable)
      .where(and(eq(positionsTable.accountId, accountId), eq(positionsTable.symbol, spec.root)));
    if (!row || row.qty === 0) return;

    const position = toEnginePosition(row, spec.root);
    const reach = this.reachFrom(spec, position, window, markTicks);
    if (reach === null) return;

    // Rounded: the average entry is fractional by nature, so an excursion
    // derived from it is too, and micro-dollars are integers.
    const mae = Math.round(Math.min(row.maeMicros, reach.worst));
    const mfe = Math.round(Math.max(row.mfeMicros, reach.best));
    const rawRisk = row.initialRiskMicros ?? (await this.protectiveRisk(accountId, spec, position));
    const risk = rawRisk === null ? null : Math.round(rawRisk);

    if (mae === row.maeMicros && mfe === row.mfeMicros && risk === row.initialRiskMicros) return;
    await this.db
      .update(positionsTable)
      .set({ maeMicros: mae, mfeMicros: mfe, initialRiskMicros: risk })
      .where(eq(positionsTable.id, row.id));
  }

  /**
   * What the position risks, per contract, from its protective stop.
   *
   * Any working stop on the other side of the position counts: a bracket leg
   * and a stop the trader placed by hand protect the position equally, and a
   * journal that only recognised the first would under-report how many trades
   * were actually taken with a defined risk.
   */
  private async protectiveRisk(
    accountId: string,
    spec: InstrumentSpec,
    position: PositionState,
  ): Promise<number | null> {
    if (position.qty === 0) return null;
    const exitSide = position.qty > 0 ? 'SELL' : 'BUY';
    const rows = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, spec.root),
          eq(ordersTable.side, exitSide),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        ),
      );

    const avgEntryTicks = position.costBasisMicros / (position.qty * spec.tickValueMicros);
    let worst: number | null = null;
    for (const row of rows) {
      if (row.stopTicks === null) continue;
      const distance = Math.abs(avgEntryTicks - row.stopTicks) * spec.tickValueMicros;
      // The furthest stop is the one that decides the risk: it is the one that
      // will still be there when the nearer ones have been moved or canceled.
      worst = worst === null ? distance : Math.max(worst, distance);
    }
    return worst;
  }

  private async setProtectionLocked(
    accountId: string,
    userId: string | null,
    symbol: string,
    levels: ProtectionLevels,
  ): Promise<EngineChange> {
    const spec = requireInstrument(symbol);
    const env = await this.loadEnvironment(accountId);
    const position = await this.loadPosition(accountId, spec.root);

    if (position.qty === 0) {
      const rejection = {
        reason: 'NO_POSITION' as const,
        message: 'There is no open position in this instrument to protect.',
      };
      await this.recordRisk(accountId, null, rejection);
      throw new OrderRejectedError(rejection.reason, rejection.message);
    }

    const snapshot = this.snapshotFor(spec);
    const markTicks = snapshot?.lastTicks ?? null;
    const long = position.qty > 0;
    const exitSide: Side = long ? 'SELL' : 'BUY';
    const qty = Math.abs(position.qty);

    // A protective level on the wrong side of the market is not protection: a
    // stop above a long's price is an instant market exit, and a target below
    // it takes a loss the trader thinks is a profit. Refused with a reason
    // rather than quietly moved.
    const check = (ticks: number, role: 'STOP_LOSS' | 'TAKE_PROFIT'): void => {
      if (markTicks === null) return;
      const belowMarket = ticks < markTicks;
      const wants = role === 'STOP_LOSS' ? long : !long;
      if (belowMarket !== wants) {
        throw new OrderRejectedError(
          'PROTECTION_ON_WRONG_SIDE',
          role === 'STOP_LOSS'
            ? `A stop for a ${long ? 'long' : 'short'} must sit ${long ? 'below' : 'above'} the market.`
            : `A target for a ${long ? 'long' : 'short'} must sit ${long ? 'above' : 'below'} the market.`,
          { level: ticksToPrice(spec, ticks), market: ticksToPrice(spec, markTicks) },
        );
      }
    };
    if (levels.stopTicks !== undefined && levels.stopTicks !== null) check(levels.stopTicks, 'STOP_LOSS');
    if (levels.targetTicks !== undefined && levels.targetTicks !== null) {
      check(levels.targetTicks, 'TAKE_PROFIT');
    }

    const openRows = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, spec.root),
          inArray(ordersTable.bracketRole, ['STOP_LOSS', 'TAKE_PROFIT']),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        ),
      );

    // Both legs share one OCO group, so whichever fills cancels the other. An
    // existing group is reused: adding a target to a position that already has
    // a stop must pair them, not leave two independent exits that could both
    // fill and flip the account.
    const groupId = openRows.find((row) => row.ocoGroupId)?.ocoGroupId ?? randomUUID();
    const now = Date.now();
    const marketNow = this.eligibilityClock(snapshot);

    const apply = async (
      role: 'STOP_LOSS' | 'TAKE_PROFIT',
      ticks: number | null | undefined,
    ): Promise<void> => {
      if (ticks === undefined) return; // untouched
      const existing = openRows.find((row) => row.bracketRole === role);

      if (ticks === null) {
        if (existing) {
          await this.db
            .update(ordersTable)
            .set({ status: 'CANCELED', version: existing.version + 1, updatedAt: new Date() })
            .where(eq(ordersTable.id, existing.id));
        }
        return;
      }

      if (existing) {
        await this.db
          .update(ordersTable)
          .set({
            ...(role === 'STOP_LOSS' ? { stopTicks: ticks } : { limitTicks: ticks }),
            qty,
            ocoGroupId: groupId,
            // Moving a level makes the order new business at that price: it has
            // not rested there, so it cannot claim a price the market traded
            // before the move.
            hasRested: false,
            restedMarketTs: snapshot?.exchangeTs ?? null,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(ordersTable.id, existing.id));
        return;
      }

      const leg = createOrder(
        {
          id: randomUUID(),
          accountId,
          clientOrderId: `protect-${role === 'STOP_LOSS' ? 'sl' : 'tp'}-${randomUUID()}`,
          symbol: spec.root,
          side: exitSide,
          qty,
          type: role === 'STOP_LOSS' ? 'STOP_MARKET' : 'LIMIT',
          stopTicks: role === 'STOP_LOSS' ? ticks : null,
          limitTicks: role === 'TAKE_PROFIT' ? ticks : null,
          tif: 'GTC',
          ocoGroupId: groupId,
          bracketRole: role,
          tradingDate: tradingDate(spec, marketNow),
          now,
          marketTs: snapshot?.exchangeTs ?? null,
          eligibleAt: marketNow + env.latencyMs,
        },
        env,
      );
      await this.db.insert(ordersTable).values(toOrderValues(leg));
    };

    await apply('STOP_LOSS', levels.stopTicks);
    await apply('TAKE_PROFIT', levels.targetTicks);

    // Pair anything that was already working into the same group, so a stop
    // placed before a target is not left orphaned beside it.
    for (const row of openRows) {
      if (row.ocoGroupId === groupId) continue;
      await this.db
        .update(ordersTable)
        .set({ ocoGroupId: groupId, version: row.version + 1, updatedAt: new Date() })
        .where(eq(ordersTable.id, row.id));
    }

    await this.audit(accountId, 'ORDER_ACCEPTED', userId, 'USER', { protection: levels }, null, null);

    // Match immediately: a level placed where the market already is should fill
    // now rather than wait for the next observation.
    return this.matchLocked(accountId, spec.root);
  }

  /**
   * Keep position-attached protection sized to the position it protects.
   *
   * The bracket legs of an entry are reconciled by syncBrackets against that
   * entry. Protection added to a position afterwards has no entry to reconcile
   * against, so it is reconciled against the position itself: it shrinks when
   * the position is reduced by hand, and goes when the position goes. Without
   * this, a stop for 3 left behind by a position cut to 1 would not close the
   * remainder - it would reverse it.
   */
  private async syncProtection(accountId: string, spec: InstrumentSpec): Promise<void> {
    const rows = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, spec.root),
          isNull(ordersTable.parentOrderId),
          inArray(ordersTable.bracketRole, ['STOP_LOSS', 'TAKE_PROFIT']),
          inArray(ordersTable.status, ['WORKING', 'PARTIALLY_FILLED']),
        ),
      );
    if (rows.length === 0) return;

    const position = await this.loadPosition(accountId, spec.root);
    for (const row of rows) {
      // A leg exits the position's direction. Flat, or flipped the other way,
      // and it protects nothing while being able to open something.
      const aligned =
        position.qty !== 0 && (row.side === 'SELL' ? position.qty > 0 : position.qty < 0);
      const target = aligned ? row.filledQty + Math.abs(position.qty) : row.filledQty;

      if (target <= row.filledQty) {
        await this.db
          .update(ordersTable)
          .set({ status: 'CANCELED', version: row.version + 1, updatedAt: new Date() })
          .where(eq(ordersTable.id, row.id));
        continue;
      }
      if (row.qty === target) continue;
      await this.db
        .update(ordersTable)
        .set({ qty: target, version: row.version + 1, updatedAt: new Date() })
        .where(eq(ordersTable.id, row.id));
    }
  }

  /**
   * Reconcile every entry order's bracket against its fills.
   *
   * Driven by stored state rather than by the submitting request, so a bracket
   * survives a restart, a latency delay, and an entry that rests for an hour
   * before filling. Legs are sized to what has ACTUALLY filled, and grow as
   * further partials arrive — an entry that is 1 of 3 filled gets a stop for 1.
   */
  private async syncBrackets(
    accountId: string,
    spec: InstrumentSpec,
    env: SimulationEnvironment,
  ): Promise<void> {
    const entryRows = await this.db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.accountId, accountId),
          eq(ordersTable.symbol, spec.root),
          eq(ordersTable.bracketRole, 'ENTRY'),
        ),
      );

    for (const row of entryRows) {
      const offsets = readBracket(row);
      if (!offsets) continue;
      const entry = toEngineOrder(row);
      if (entry.filledQty <= 0) continue;

      // EVERY child, in any state. Looking only at open ones would recreate the
      // bracket after it had done its job — the stop fills, the target cancels,
      // both are closed, and the next market event sees "no open children" and
      // builds a fresh pair. That reopens protection for a position that is
      // gone, and collides on the leg's client order id.
      const allChildren = await this.db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.parentOrderId, entry.id));

      if (allChildren.length === 0) {
        // Only create legs while the entry still has exposure to protect. A
        // fully closed entry must not sprout a stop that would open a new one.
        const position = await this.loadPosition(accountId, spec.root);
        if (position.qty === 0) continue;
        await this.createBracketLegs(accountId, spec, entry, offsets, env);
        continue;
      }

      // A bracket protects the POSITION between its legs, not the quantity it
      // was created with. It therefore tracks the position in both directions:
      // it grows as further partials fill the entry, and it shrinks - to
      // nothing, if need be - when the position is reduced by hand.
      //
      // Without the shrink, a stop still sized for the original quantity does
      // not close a reduced position: it reverses it.
      const position = await this.loadPosition(accountId, spec.root);
      const entryDirection = entry.side === 'BUY' ? 1 : -1;
      // Legs exit the entry's direction. If the position is flat, or has flipped
      // to the other side, they no longer protect anything and would open new
      // exposure if they fired.
      const aligned = Math.sign(position.qty) === entryDirection;
      const protectQty = aligned ? Math.abs(position.qty) : 0;

      for (const child of allChildren) {
        if (child.status !== 'WORKING' && child.status !== 'PARTIALLY_FILLED') continue;

        // A leg's quantity covers what it has already done plus what is still
        // open: a stop that filled 1 of 2 reduced the position by that 1, so it
        // still needs its remaining 1 to close what is left. Capped by the
        // entry, because a bracket protects the position its entry opened and
        // not whatever else the trader has stacked on top of it.
        const target = Math.min(entry.filledQty, child.filledQty + protectQty);

        if (target <= child.filledQty) {
          await this.db
            .update(ordersTable)
            .set({ status: 'CANCELED', version: child.version + 1, updatedAt: new Date() })
            .where(eq(ordersTable.id, child.id));
          continue;
        }
        if (child.qty === target) continue;
        await this.db
          .update(ordersTable)
          .set({ qty: target, version: child.version + 1, updatedAt: new Date() })
          .where(eq(ordersTable.id, child.id));
      }

      // The trade is over, so the entry's unfilled remainder goes with it. A
      // bracket whose legs have been dismantled must not be able to fill again
      // into a position with no protection.
      if (protectQty === 0 && (entry.status === 'WORKING' || entry.status === 'PARTIALLY_FILLED')) {
        await this.db
          .update(ordersTable)
          .set({ status: 'CANCELED', version: entry.version + 1, updatedAt: new Date() })
          .where(eq(ordersTable.id, entry.id));
      }
    }
  }

  /**
   * Create the protective legs of a bracket, linked as an OCO pair.
   *
   * Offsets are measured from the entry's ACTUAL average fill, not from the
   * price the trader was looking at: a bracket drawn around a price that never
   * filled protects nothing.
   */
  private async createBracketLegs(
    accountId: string,
    spec: InstrumentSpec,
    entry: EngineOrder,
    offsets: BracketOffsets,
    env: SimulationEnvironment,
  ): Promise<void> {
    const avgTicks = entry.fillNotionalMicros / (entry.filledQty * spec.tickValueMicros);
    const exitSide: Side = entry.side === 'BUY' ? 'SELL' : 'BUY';
    const direction = entry.side === 'BUY' ? 1 : -1;
    const groupId = randomUUID();
    const now = Date.now();
    const qty = entry.filledQty;

    // Eligibility is measured on the SAME clock the matcher uses, which in a
    // replay is the recording's and not the server's. A leg stamped with the
    // wall clock inside a replay of last Tuesday is dated days after every
    // observation it will ever see, so it can never become eligible: the stop
    // is drawn on the chart, price trades straight through it, and nothing
    // fills. The entry escaped this because it is submitted through
    // submitLocked, which already had the market's clock in hand.
    const snapshot = this.snapshotFor(spec);
    const marketNow = this.eligibilityClock(snapshot);

    const legs: EngineOrder[] = [];
    const base = {
      accountId,
      symbol: spec.root,
      side: exitSide,
      qty,
      tif: 'GTC' as const,
      ocoGroupId: groupId,
      parentOrderId: entry.id,
      // The trading day a leg belongs to is the market's, for the same reason:
      // a replayed session's orders belong to the day being replayed.
      tradingDate: tradingDate(spec, marketNow),
      now,
      eligibleAt: marketNow + env.latencyMs,
      // The legs exist from the moment the entry filled, so that is their place
      // in market time - not the server clock, which on a delayed feed runs
      // minutes ahead of everything the engine can see.
      marketTs: entry.updatedAt,
    };

    if (offsets.stopLossTicks && offsets.stopLossTicks > 0) {
      legs.push(
        createOrder(
          {
            ...base,
            id: randomUUID(),
            clientOrderId: `${entry.clientOrderId}-sl`,
            type: 'STOP_MARKET',
            stopTicks: Math.round(avgTicks - direction * offsets.stopLossTicks),
            bracketRole: 'STOP_LOSS',
          },
          env,
        ),
      );
    }

    if (offsets.takeProfitTicks && offsets.takeProfitTicks > 0) {
      legs.push(
        createOrder(
          {
            ...base,
            id: randomUUID(),
            clientOrderId: `${entry.clientOrderId}-tp`,
            type: 'LIMIT',
            limitTicks: Math.round(avgTicks + direction * offsets.takeProfitTicks),
            bracketRole: 'TAKE_PROFIT',
          },
          env,
        ),
      );
    }

    if (offsets.trailingStopTicks && offsets.trailingStopTicks > 0) {
      legs.push(
        createOrder(
          {
            ...base,
            id: randomUUID(),
            clientOrderId: `${entry.clientOrderId}-trail`,
            type: 'TRAILING_STOP',
            trailTicks: offsets.trailingStopTicks,
            bracketRole: 'STOP_LOSS',
          },
          env,
        ),
      );
    }

    for (const leg of legs) {
      await this.db.insert(ordersTable).values(toOrderValues(leg));
    }
    if (legs.length > 0) {
      await this.audit(accountId, 'ORDER_ACCEPTED', null, 'ENGINE', { bracket: offsets }, null, legs);
    }
  }

  // -- helpers -------------------------------------------------------------

  private async loadOpenAndRecent(accountId: string, symbol: string): Promise<EngineOrder[]> {
    const rows = await this.db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.accountId, accountId), eq(ordersTable.symbol, symbol)))
      .orderBy(sql`${ordersTable.createdAt} desc`)
      .limit(200);
    return rows.map(toEngineOrder);
  }

  private async loadRiskAccount(accountId: string) {
    // Through the shared loader, so an account pinned to a product version and
    // one that predates products arrive in the same shape. An inner join on
    // the old template table would refuse every order on a provisioned
    // account, because a provisioned account does not have one.
    const loaded = await loadAccountAndTemplate(this.db, accountId);
    if (!loaded?.template) throw new OrderRejectedError('ACCOUNT_NOT_FOUND', 'No such account.');
    const { account, template } = loaded;
    return {
      id: account.id,
      status: account.status,
      maxContracts: template.maxContracts,
      microsCountAsFraction: template.microsCountAsFraction,
      failedReason: account.failedReason,
      instruments: await this.instrumentPolicy(account),
    };
  }

  /**
   * What the account may trade.
   *
   * The product's policy, with the account's own overrides laid over it: a
   * firm sells a product, and support can narrow one trader's account without
   * inventing a new product for them.
   */
  private async instrumentPolicy(account: {
    profileVersionId: string | null;
    instrumentLimits: unknown;
  }): Promise<InstrumentPolicy | null> {
    let fromProduct: InstrumentPolicy | null = null;
    if (account.profileVersionId) {
      const [version] = await this.db
        .select({ config: accountProfileVersions.config })
        .from(accountProfileVersions)
        .where(eq(accountProfileVersions.id, account.profileVersionId));
      const instruments = (version?.config as { instruments?: InstrumentPolicy } | null)
        ?.instruments;
      if (instruments) fromProduct = instruments;
    }
    const override = (account.instrumentLimits ?? null) as InstrumentPolicy | null;
    if (!fromProduct && !override) return null;
    return { ...(fromProduct ?? {}), ...(override ?? {}) };
  }

  private async openContractWeight(accountId: string, microsAsFraction: boolean): Promise<number> {
    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.accountId, accountId));
    let total = 0;
    for (const row of rows) {
      if (row.qty === 0) continue;
      const spec = requireInstrument(row.symbol);
      total += contractWeight(spec, Math.abs(row.qty), microsAsFraction);
    }
    return total;
  }

  private async nextSeq(tx: Database, accountId: string, count: number): Promise<number> {
    if (count === 0) return 0;
    const [row] = await tx
      .update(accounts)
      .set({ seq: sql`${accounts.seq} + ${count}` })
      .where(eq(accounts.id, accountId))
      .returning({ seq: accounts.seq });
    return (row?.seq ?? count) - count + 1;
  }

  private async audit(
    accountId: string,
    type: string,
    userId: string | null,
    source: 'USER' | 'ENGINE' | 'RISK' | 'SYSTEM',
    request: unknown,
    prevState: unknown,
    newState: unknown,
  ): Promise<void> {
    const [row] = await this.db
      .update(accounts)
      .set({ seq: sql`${accounts.seq} + 1` })
      .where(eq(accounts.id, accountId))
      .returning({ seq: accounts.seq });
    await this.db.insert(accountEvents).values({
      accountId,
      seq: row?.seq ?? 0,
      type,
      userId,
      source,
      request: request as never,
      prevState: prevState as never,
      newState: newState as never,
    });
  }

  private async recordRisk(
    accountId: string,
    orderId: string | null,
    rejection: RiskRejection,
  ): Promise<void> {
    await this.db.insert(riskEvents).values({
      accountId,
      orderId,
      rule: rejection.reason,
      reasonCode: rejection.reason,
      detail: (rejection.detail ?? {}) as never,
    });
  }

  private async buildChange(
    accountId: string,
    spec: InstrumentSpec,
    orderList: EngineOrder[],
    fills: EngineChange['fills'],
    tradeRows: Array<Record<string, unknown>>,
    position?: PositionState,
  ): Promise<EngineChange> {
    const resolved = position ?? (await this.loadPosition(accountId, spec.root));
    const markTicks = this.markTicks(spec);
    const open = orderList.filter(isOpen);
    const stop = open.find((o) => o.bracketRole === 'STOP_LOSS')?.id ?? null;
    const target = open.find((o) => o.bracketRole === 'TAKE_PROFIT')?.id ?? null;

    const [accountRow] = await this.db
      .select({ balance: accounts.balanceMicros, seq: accounts.seq })
      .from(accounts)
      .where(eq(accounts.id, accountId));

    return {
      accountId,
      seq: accountRow?.seq ?? 0,
      orders: orderList.map((o) => presentOrder(o, spec)),
      position:
        resolved.qty === 0 && orderList.length === 0
          ? null
          : presentPosition(
              resolved,
              spec,
              markTicks,
              unrealizedPnlMicros(spec, resolved, markTicks),
              { stopOrderId: stop, targetOrderId: target },
            ),
      fills,
      trades: tradeRows,
      balanceMicros: accountRow?.balance ?? 0,
    };
  }

  markTicks(spec: InstrumentSpec): number | null {
    const mark = this.market.markPrice(spec.root);
    return mark === null ? null : priceToTicks(spec, mark);
  }

  /**
   * The mark that applies to ONE position, or null when none does.
   *
   * A position is priced by the market it was opened against and by no other.
   * Starting a practice replay swaps the platform's data source, and marking a
   * live position at a recording's prices produced figures like a $5,920 loss
   * on a position that had moved five dollars - and, when the recording's
   * prices were higher, a high-water mark the account keeps for ever.
   *
   * A position stored before this rule existed has no era recorded. It is
   * marked as before: inventing a reason not to price it would be its own
   * defect.
   */
  markTicksFor(
    spec: InstrumentSpec,
    position: { marketEra: string | null; contractCode?: string | null },
  ): number | null {
    if (position.marketEra !== null && position.marketEra !== this.market.era()) return null;
    // The open-position contract lock. A position opened in a specific contract
    // is never marked by a different contract's prices. Atlas's live/chart feed
    // is keyed on the ROOT and carries the current front month; once that has
    // rolled past this position's contract, the root feed is a DIFFERENT
    // contract, so the position reads UNKNOWN (never a wrong mark, never a
    // silent roll) until it can be marked by its own contract. A legacy
    // position with no contract (null) marks as before.
    if (position.contractCode != null) {
      const markTime = this.market.getQuote(spec.root)?.exchangeTs ?? Date.now();
      const current = contractResolver.contractCode(spec.root, markTime);
      if (current !== null && current !== position.contractCode) return null;
    }
    return this.markTicks(spec);
  }

  /** Expose helpers the read APIs need without duplicating mapping logic. */
  async positionView(accountId: string, symbol: string) {
    const spec = requireInstrument(symbol);
    const position = await this.loadPosition(accountId, spec.root);
    const markTicks = this.markTicks(spec);
    const open = (await this.loadOpenAndRecent(accountId, spec.root)).filter(isOpen);
    return presentPosition(position, spec, markTicks, unrealizedPnlMicros(spec, position, markTicks), {
      stopOrderId: open.find((o) => o.bracketRole === 'STOP_LOSS')?.id ?? null,
      targetOrderId: open.find((o) => o.bracketRole === 'TAKE_PROFIT')?.id ?? null,
    });
  }

  get diagnostics() {
    return {
      activeKeys: this.mutex.activeKeys,
      trackedSymbols: [...this.activeSymbols.keys()],
    };
  }
}

/**
 * Has anything about this order changed that must be persisted?
 *
 * Comparing versions alone is not enough, and the difference is not cosmetic.
 * Several pieces of engine state advance WITHOUT a version bump, because they
 * are not modifications the trader made:
 *
 *   - `hasRested` decides whether a limit still gets arrival pricing. If it is
 *     never written, a resting limit is treated as newly arrived on every
 *     market event and keeps taking the market's price instead of its own.
 *   - `trailAnchorTicks` is a trailing stop's memory of the best price seen. If
 *     it is never written, the anchor resets to the current price every event
 *     and the stop follows price down instead of trailing it.
 *   - `stopTriggered` records that a stop-limit has been elected.
 */
function orderChanged(before: EngineOrder, after: EngineOrder): boolean {
  return (
    before.version !== after.version ||
    before.status !== after.status ||
    before.filledQty !== after.filledQty ||
    before.fillNotionalMicros !== after.fillNotionalMicros ||
    before.hasRested !== after.hasRested ||
    before.restedMarketTs !== after.restedMarketTs ||
    before.stopTriggered !== after.stopTriggered ||
    before.trailAnchorTicks !== after.trailAnchorTicks ||
    before.stopTicks !== after.stopTicks ||
    before.limitTicks !== after.limitTicks ||
    before.qty !== after.qty
  );
}

function describeModifyFailure(reason: string | undefined): string {
  switch (reason) {
    case 'QUANTITY_BELOW_FILLED':
      return 'Cannot reduce quantity below what has already filled.';
    case 'INVALID_QUANTITY':
      return 'Quantity must be a positive whole number.';
    default:
      return 'This order can no longer be modified.';
  }
}

export { applyFill, avgEntryTicks, flatPosition, remainingQty };
