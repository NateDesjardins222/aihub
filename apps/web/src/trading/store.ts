/**
 * Trading state store.
 *
 * Holds a REPLICA of the server's trading state. It is refreshed from the REST
 * read APIs on connect and whenever the WebSocket says something changed; it
 * never computes a fill, a position or a P&L figure of its own.
 *
 * Unlike market ticks, trading state changes rarely — a handful of times a
 * minute at most — so it lives in React state without costing anything.
 */
import { create } from 'zustand';
import { marketStream } from '../market/stream';
import { execLatency } from './exec-latency';
import { tradingAudio } from '../audio/trading-audio';
import { EMPTY_SNAPSHOT, snapshotOf, soundsFor } from '../audio/execution-events';
import { mergePnlFrame } from './pnl-merge';
import {
  tradingApi,
  type ApiAccountPnl,
  type ApiRules,
  type ApiRuleStatus,
  type ApiExecution,
  type ApiOrder,
  type ApiPosition,
  type ApiTrade,
  type SimulationEnvironment,
} from './api';

interface TradingState {
  accountId: string | null;
  orders: ApiOrder[];
  positions: ApiPosition[];
  trades: ApiTrade[];
  executions: ApiExecution[];
  pnl: ApiAccountPnl | null;
  /** Live rule status, pushed with every valuation frame. */
  rules: ApiRuleStatus | null;
  /** The programme itself: limits, requirements and the days behind them. */
  ruleBook: ApiRules | null;
  environment: SimulationEnvironment | null;
  depthAwareAvailable: boolean;
  loading: boolean;
  error: string | null;
  /** Last rejection, kept so the order ticket can explain itself. */
  lastRejection: { code: string; message: string } | null;

  attach: (accountId: string) => void;
  refresh: () => Promise<void>;
  readAll: (accountId: string) => Promise<void>;
  refreshPnl: () => Promise<void>;
  loadEnvironment: () => Promise<void>;
  loadRules: () => Promise<void>;
  setEnvironment: (patch: Partial<SimulationEnvironment>) => Promise<void>;
  setError: (message: string | null) => void;
  setRejection: (rejection: { code: string; message: string } | null) => void;
}

let detach: (() => void) | null = null;

/**
 * Refresh coalescing.
 *
 * Account streams fire on every fill, every order change and every market event
 * that touches a working order. Calling refresh() on each one issues five REST
 * requests, and a busy symbol will exhaust the browser's connection pool —
 * observed as ERR_INSUFFICIENT_RESOURCES and a UI that stops updating.
 *
 * So: at most one refresh in flight, at most one queued behind it, and a short
 * debounce to let a burst of frames settle into a single read.
 */
const REFRESH_DEBOUNCE_MS = 250;

/** The last authoritative picture a sound was decided from, and whose it was. */
let lastSounded = EMPTY_SNAPSHOT;
let soundAccount: string | null = null;
let refreshTimer: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;
/**
 * The exchange/compute timestamp of the last valuation frame applied. A delayed
 * frame (an older `at`) is dropped so the displayed P&L never rolls backward.
 * Reset to 0 on every account switch.
 */
let lastPnlAt = 0;

export const useTrading = create<TradingState>((set, get) => ({
  accountId: null,
  orders: [],
  positions: [],
  trades: [],
  executions: [],
  pnl: null,
  rules: null,
  ruleBook: null,
  environment: null,
  depthAwareAvailable: false,
  loading: false,
  error: null,
  lastRejection: null,

  attach(accountId) {
    if (get().accountId === accountId) return;
    detach?.();
    // A different account's picture is not this account's history: forget it,
    // so the first read of the new one is silent rather than announcing the
    // difference between two unrelated accounts.
    lastSounded = EMPTY_SNAPSHOT;
    soundAccount = null;
    lastPnlAt = 0;
    set({
      accountId,
      orders: [],
      positions: [],
      trades: [],
      executions: [],
      pnl: null,
      rules: null,
      ruleBook: null,
    });

    marketStream.connect();
    // Follow the account's streams. The server pushes; nothing here polls for
    // a fill.
    const schedule = (): void => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void get().refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const offs = [
      marketStream.subscribeRaw(`acct.${accountId}.orders`, schedule),
      marketStream.subscribeRaw(`acct.${accountId}.positions`, schedule),
      marketStream.subscribeRaw(`acct.${accountId}.executions`, schedule),
      marketStream.subscribeRaw(`acct.${accountId}.trades`, schedule),
      // A valuation frame carries the whole picture, so it is applied directly.
      // Re-reading over REST for a figure that arrived in the frame is what
      // exhausted the browser's connection pool.
      marketStream.subscribeRaw(`acct.${accountId}.pnl`, (data) => {
        const valuation = data as {
          accountId?: string;
          at?: number;
          balanceMicros?: number;
          equityMicros?: number | null;
          openPnlMicros?: number | null;
          dayPnlMicros?: number | null;
          remainingDrawdownMicros?: number | null;
          openContracts?: number;
          rules?: ApiRuleStatus;
          unmarkable?: ApiAccountPnl['unmarkable'];
          positions?: Array<{ symbol: string; unrealizedPnlMicros: number | null; markPrice: number | null }>;
        } | null;
        // Drop a frame for any account other than the one on screen NOW - not
        // merely the account this subscription was opened for. After an account
        // switch a frame for the previous account can still be in flight; it
        // must never overwrite the account the trader is now looking at.
        if (!valuation || valuation.accountId !== get().accountId) return;
        // Monotonic: never apply a frame older than the last one applied, so a
        // delayed valuation cannot roll the displayed P&L backward.
        if (typeof valuation.at === 'number') {
          if (valuation.at < lastPnlAt) return;
          lastPnlAt = valuation.at;
        }

        // A status change is the one thing that needs the authoritative read:
        // a failed account's orders and positions have just been closed by the
        // server, and the replica has to catch up rather than guess.
        const previousStatus = get().rules?.status;
        if (valuation.rules && previousStatus && valuation.rules.status !== previousStatus) {
          schedule();
        }

        set((state) => ({
          rules: valuation.rules ?? state.rules,
          // Null-honest merge (D-13): an authoritative null propagates so the
          // terminal never shows a phantom/stale P&L; see trading/pnl-merge.ts.
          pnl: state.pnl ? mergePnlFrame(state.pnl, valuation) : state.pnl,
          // Mark-driven fields only. Quantity, average entry and protective
          // order links come from the authoritative read, not from here.
          positions: state.positions.map((p) => {
            const update = valuation.positions?.find((v) => v.symbol === p.symbol);
            return update
              ? { ...p, unrealizedPnlMicros: update.unrealizedPnlMicros, markPrice: update.markPrice }
              : p;
          }),
        }));
      }),
    ];
    detach = () => offs.forEach((off) => off());

    void get().refresh();
    void get().loadEnvironment();
    void get().loadRules();
  },

  async refresh() {
    const accountId = get().accountId;
    if (!accountId) return;

    // Never run two reads at once; queue at most one follow-up so the last
    // change is always reflected without issuing a request per frame.
    if (refreshInFlight) {
      refreshQueued = true;
      await refreshInFlight;
      return;
    }

    const task = get().readAll(accountId);
    refreshInFlight = task;
    try {
      await task;
    } finally {
      refreshInFlight = null;
      if (refreshQueued) {
        refreshQueued = false;
        void get().refresh();
      }
    }
  },

  async readAll(accountId: string) {
    set({ loading: true });
    try {
      const [orders, positions, trades, executions, pnl, ruleBook] = await Promise.all([
        tradingApi.orders(accountId),
        tradingApi.positions(accountId),
        tradingApi.trades(accountId),
        tradingApi.executions(accountId),
        tradingApi.pnl(accountId),
        tradingApi.rules(accountId).catch(() => null),
      ]);
      /*
       * THE ANSWER TO A QUESTION NOBODY IS ASKING ANY MORE.
       *
       * Six reads are in flight for the account that was selected when this
       * started. A trader who switches accounts while they are travelling
       * gets them back AFTER the switch - and writing them would put account
       * A's orders, positions, trades and P&L into a terminal that is now
       * showing account B, with nothing on screen to say so. The chart solved
       * this for market data with a load token; this is the same guard for
       * money.
       */
      if (get().accountId !== accountId) return;
      /*
       * The order the trader asked for is now in authoritative state.
       *
       * This is the moment the round trip actually closes: not when the POST
       * returned, but when the server's own view of the account carries the
       * order. The instrument stops its clock here and takes the paint
       * measurement from the frame this state produces.
       */
      for (const order of orders.orders) execLatency.reconciled(order.clientOrderId);

      /*
       * The only place a trading sound is decided.
       *
       * Server state against server state: an order that reached FILLED, a
       * position that reached zero. No click reaches this code, which is why
       * pressing BUY can never announce a fill that did not happen, and an
       * order that never fills is never announced.
       *
       * The snapshot is per account and starts empty, so the first read after
       * a reload or an account switch is silent - everything in it already
       * happened, and a terminal that greets a trader by replaying this
       * morning's fills is broken.
       */
      if (soundAccount === accountId) {
        for (const sound of soundsFor(lastSounded, orders.orders, positions.positions)) {
          tradingAudio.play(sound);
        }
      }
      lastSounded = snapshotOf(orders.orders, positions.positions);
      soundAccount = accountId;

      set({
        orders: orders.orders,
        positions: positions.positions,
        trades: trades.trades,
        executions: executions.executions,
        pnl,
        ruleBook: ruleBook ?? get().ruleBook,
        rules: ruleBook?.status ?? get().rules,
        error: null,
      });
    } catch (err) {
      // An error belongs to the account that asked for it, too.
      if (get().accountId === accountId) {
        set({ error: err instanceof Error ? err.message : 'Failed to load trading state.' });
      }
    } finally {
      if (get().accountId === accountId) set({ loading: false });
    }
  },

  async refreshPnl() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const pnl = await tradingApi.pnl(accountId);
      // Same guard as readAll: a valuation that lands after the trader has
      // moved on belongs to an account they are no longer looking at.
      if (get().accountId !== accountId) return;
      set({ pnl });
    } catch {
      /* the next refresh will pick it up */
    }
  },

  async loadRules() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const ruleBook = await tradingApi.rules(accountId);
      set({ ruleBook, rules: ruleBook.status ?? get().rules });
    } catch {
      /* the risk panel shows its own error */
    }
  },

  async loadEnvironment() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const result = await tradingApi.environment(accountId);
      set({ environment: result.environment, depthAwareAvailable: result.depthAwareAvailable });
    } catch {
      /* settings panel shows its own error */
    }
  },

  async setEnvironment(patch) {
    const accountId = get().accountId;
    if (!accountId) return;
    const result = await tradingApi.setEnvironment(accountId, patch);
    set({ environment: result.environment });
  },

  setError(message) {
    set({ error: message });
  },

  setRejection(rejection) {
    set({ lastRejection: rejection });
  },
}));

/**
 * Open P&L across every position, or NULL when one of them cannot be priced.
 *
 * Unknown does not add up to zero. One position the platform cannot price
 * makes the total unknown, and the terminal shows a dash for it.
 */
export function openPnlMicros(state: TradingState): number | null {
  let total = 0;
  for (const p of state.positions) {
    if (p.qty === 0) continue;
    if (p.unrealizedPnlMicros === null) return null;
    total += p.unrealizedPnlMicros;
  }
  return total;
}

export function positionFor(state: TradingState, symbol: string): ApiPosition | null {
  return state.positions.find((p) => p.symbol === symbol && p.qty !== 0) ?? null;
}

export function workingOrders(state: TradingState): ApiOrder[] {
  return state.orders.filter(
    (o) => o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED' || o.status === 'CANCEL_PENDING',
  );
}
