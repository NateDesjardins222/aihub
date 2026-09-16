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
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { priceToTicks, requireInstrument, tradingDate, contractWeight } from '@atlas/instruments';
import type { Database } from '../db/client.js';
import {
  accountEvents,
  accounts,
  executions,
  orders as ordersTable,
  positions as positionsTable,
  riskEvents,
  ruleTemplates,
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
}
import { KeyedMutex } from './mutex.js';
import { checkOrder, increasingQty, type RiskRejection } from './risk.js';
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

export interface BracketOffsets {
  readonly stopLossTicks?: number | null;
  readonly takeProfitTicks?: number | null;
  readonly trailingStopTicks?: number | null;
}

export interface SubmitOrderInput {
  readonly accountId: string;
  readonly userId: string;
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
  readonly equityMicros: number;
  readonly openPnlMicros: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  readonly dayPnlMicros: number;
  readonly remainingDrawdownMicros: number;
  readonly openContracts: number;
  readonly positions: ReturnType<typeof presentPosition>[];
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
  private readonly mutex = new KeyedMutex();
  private readonly listeners = new Set<ChangeListener>();
  private readonly valuationListeners = new Set<ValuationListener>();
  /** Account+symbol pairs with a market-event match already queued. */
  private readonly pendingMatches = new Set<string>();
  private valuationTimer: NodeJS.Timeout | null = null;
  /** Accounts currently holding a position or working order, by symbol. */
  private readonly activeSymbols = new Map<string, Set<string>>();
  private marketUnsubscribe: (() => void) | null = null;
  /** Pending latency wake-ups, so a shutdown does not leave timers running. */
  private readonly pendingWakes = new Set<NodeJS.Timeout>();

  constructor(
    private readonly db: Database,
    private readonly market: MarketView,
  ) {}

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
    await this.refreshActiveSymbols();

    const offQuote = this.market.bus.onAnyQuote((quote) => {
      void this.onMarketEvent(quote.symbol).catch(() => undefined);
    });
    const offBar = this.market.bus.onAnyBar((bar) => {
      if (!bar.closed) return; // a forming bar's extremes are not final
      void this.onMarketEvent(bar.symbol).catch(() => undefined);
    });
    this.marketUnsubscribe = () => {
      offQuote();
      offBar();
    };

    // Revalue open accounts on a steady cadence rather than on every tick: the
    // figure must track the market, but a push per quote per account would be
    // a lot of traffic for a number that only needs to look live.
    this.valuationTimer = setInterval(() => {
      void this.publishValuations().catch(() => undefined);
    }, VALUATION_INTERVAL_MS);
    this.valuationTimer.unref?.();
  }

  /** Revalue every account holding a position and push the result. */
  private async publishValuations(): Promise<void> {
    if (this.valuationListeners.size === 0) return;

    const rows = await this.db
      .select({ accountId: positionsTable.accountId })
      .from(positionsTable)
      .where(sql`${positionsTable.qty} <> 0`);
    const accountIds = [...new Set(rows.map((r) => r.accountId))];

    for (const accountId of accountIds) {
      const valuation = await this.valuation(accountId);
      if (valuation) for (const listener of this.valuationListeners) listener(valuation);
    }
  }

  /** Current valuation of an account, marked to the live market. */
  async valuation(accountId: string): Promise<AccountValuation | null> {
    const [account] = await this.db.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) return null;

    const rows = await this.db
      .select()
      .from(positionsTable)
      .where(eq(positionsTable.accountId, accountId));

    let openPnlMicros = 0;
    let openContracts = 0;
    const views: ReturnType<typeof presentPosition>[] = [];

    for (const row of rows) {
      if (row.qty === 0) continue;
      const spec = requireInstrument(row.symbol);
      const position = toEnginePosition(row, row.symbol);
      const markTicks = this.markTicks(spec);
      const unrealized = unrealizedPnlMicros(spec, position, markTicks);
      openPnlMicros += unrealized;
      openContracts += Math.abs(row.qty);
      views.push(
        presentPosition(position, spec, markTicks, unrealized, {
          stopOrderId: null,
          targetOrderId: null,
        }),
      );
    }

    const equityMicros = account.balanceMicros + openPnlMicros;
    return {
      accountId,
      balanceMicros: account.balanceMicros,
      equityMicros,
      openPnlMicros,
      realizedPnlMicros: account.realizedPnlMicros,
      feesMicros: account.feesMicros,
      dayPnlMicros: account.balanceMicros - account.dayStartBalanceMicros + openPnlMicros,
      remainingDrawdownMicros: equityMicros - account.drawdownFloorMicros,
      openContracts,
      positions: views,
      at: Date.now(),
    };
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
    const delay = eligibleAt - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => {
      this.pendingWakes.delete(timer);
      void this.runMatch(accountId, symbol).catch(() => undefined);
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

  private async onMarketEvent(symbol: string): Promise<void> {
    const accountIds = this.activeSymbols.get(symbol);
    if (!accountIds || accountIds.size === 0) return;
    for (const accountId of [...accountIds]) {
      const key = `${accountId}|${symbol}`;
      // A match reads the CURRENT market, so two queued matches for the same
      // account and symbol do the same work twice. Collapsing them keeps a
      // burst of market events from building a queue that every later order,
      // cancel or flatten has to wait behind. The flag is cleared as the task
      // starts, not when it finishes, so an event arriving mid-match still
      // earns a fresh pass over the new data.
      if (this.pendingMatches.has(key)) continue;
      this.pendingMatches.add(key);
      await this.mutex.run(accountId, () => {
        this.pendingMatches.delete(key);
        return this.matchLocked(accountId, symbol);
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

  async submitOrder(input: SubmitOrderInput): Promise<EngineChange> {
    return this.mutex.run(input.accountId, () => this.submitLocked(input));
  }

  async modifyOrder(
    accountId: string,
    orderId: string,
    patch: { qty?: number; limitTicks?: number | null; stopTicks?: number | null; trailTicks?: number | null },
    expectedVersion?: number,
  ): Promise<EngineChange> {
    return this.mutex.run(accountId, () => this.modifyLocked(accountId, orderId, patch, expectedVersion));
  }

  async cancelOrder(accountId: string, orderId: string): Promise<EngineChange> {
    return this.mutex.run(accountId, () => this.cancelLocked(accountId, orderId));
  }

  async cancelAll(accountId: string, symbol?: string): Promise<EngineChange> {
    return this.mutex.run(accountId, () => this.cancelAllLocked(accountId, symbol));
  }

  /** Close a position at market. */
  async flatten(accountId: string, userId: string, symbol: string): Promise<EngineChange> {
    return this.mutex.run(accountId, async () => {
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
  }

  /** Flip a position to the same size on the other side. */
  async reverse(accountId: string, userId: string, symbol: string): Promise<EngineChange> {
    return this.mutex.run(accountId, async () => {
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
        tradingDate: tradingDate(spec, now),
        now,
        // Where the order sits in MARKET time, which is what decides which
        // bars are allowed to fill it.
        marketTs: snapshot?.exchangeTs ?? null,
      },
      env,
    );

    await this.db
      .insert(ordersTable)
      .values({ ...toOrderValues(entry), bracketConfig: (input.bracket ?? null) as never });
    this.track(input.accountId, spec.root);
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
  private async matchLocked(accountId: string, symbol: string): Promise<EngineChange> {
    const spec = requireInstrument(symbol);
    const env = await this.loadEnvironment(accountId);
    const snapshot = this.snapshotFor(spec);

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
    const position = await this.loadPosition(accountId, spec.root);

    if (!snapshot || openOrders.length === 0) {
      return this.buildChange(accountId, spec, openOrders, [], [], position);
    }

    const result = matchOrders(
      { spec, env, market: snapshot, now: Date.now() },
      openOrders,
      position,
    );

    const changedOrders = result.orders.filter((o) => {
      const before = openOrders.find((x) => x.id === o.id);
      return !before || orderChanged(before, o);
    });

    const executionRows: EngineChange['fills'] = [];
    const tradeRows: Array<Record<string, unknown>> = [];

    if (result.fills.length > 0 || changedOrders.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const order of changedOrders) {
          await tx.update(ordersTable).set(toOrderValues(order)).where(eq(ordersTable.id, order.id));
        }

        // Position
        await tx
          .insert(positionsTable)
          .values(toPositionValues(accountId, result.position))
          .onConflictDoUpdate({
            target: [positionsTable.accountId, positionsTable.symbol],
            set: {
              side: sql`excluded.side`,
              qty: sql`excluded.qty`,
              costBasisMicros: sql`excluded.cost_basis_micros`,
              realizedPnlMicros: sql`excluded.realized_pnl_micros`,
              feesMicros: sql`excluded.fees_micros`,
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

        // Closed round-trips
        for (const lot of result.closedLots) {
          const row = this.tradeRow(accountId, spec, lot, result.feesMicros);
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
    } catch (err) {
      await this.audit(accountId, 'RISK_RULE_TRIGGERED', null, 'ENGINE', { bracketSyncFailed: true }, null, {
        message: err instanceof Error ? err.message : String(err),
      });
    }

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

  private tradeRow(
    accountId: string,
    spec: InstrumentSpec,
    lot: ClosedLot,
    feesMicros: number,
  ): Record<string, unknown> {
    return {
      accountId,
      symbol: spec.root,
      side: lot.side,
      qty: lot.qty,
      entryTicksScaled: scaleTicks(lot.entryTicks),
      exitTicksScaled: scaleTicks(lot.exitTicks),
      entryTime: new Date(lot.openedAt ?? lot.closedAt),
      exitTime: new Date(lot.closedAt),
      grossPnlMicros: lot.grossPnlMicros,
      feesMicros,
      netPnlMicros: lot.grossPnlMicros - feesMicros,
      tradeDate: tradingDate(spec, lot.closedAt),
    };
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

    const legs: EngineOrder[] = [];
    const base = {
      accountId,
      symbol: spec.root,
      side: exitSide,
      qty,
      tif: 'GTC' as const,
      ocoGroupId: groupId,
      parentOrderId: entry.id,
      tradingDate: tradingDate(spec, now),
      now,
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
    const [row] = await this.db
      .select({ account: accounts, template: ruleTemplates })
      .from(accounts)
      .innerJoin(ruleTemplates, eq(accounts.ruleTemplateId, ruleTemplates.id))
      .where(eq(accounts.id, accountId));
    if (!row) throw new OrderRejectedError('ACCOUNT_NOT_FOUND', 'No such account.');
    return {
      id: row.account.id,
      status: row.account.status,
      maxContracts: row.template.maxContracts,
      microsCountAsFraction: row.template.microsCountAsFraction,
    };
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
