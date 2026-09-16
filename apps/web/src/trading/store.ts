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
let refreshTimer: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

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
          balanceMicros?: number;
          equityMicros?: number;
          openPnlMicros?: number;
          dayPnlMicros?: number;
          remainingDrawdownMicros?: number;
          openContracts?: number;
          rules?: ApiRuleStatus;
          positions?: Array<{ symbol: string; unrealizedPnlMicros: number; markPrice: number | null }>;
        } | null;
        if (!valuation || valuation.accountId !== accountId) return;

        // A status change is the one thing that needs the authoritative read:
        // a failed account's orders and positions have just been closed by the
        // server, and the replica has to catch up rather than guess.
        const previousStatus = get().rules?.status;
        if (valuation.rules && previousStatus && valuation.rules.status !== previousStatus) {
          schedule();
        }

        set((state) => ({
          rules: valuation.rules ?? state.rules,
          pnl: state.pnl
            ? {
                ...state.pnl,
                balanceMicros: valuation.balanceMicros ?? state.pnl.balanceMicros,
                equityMicros: valuation.equityMicros ?? state.pnl.equityMicros,
                openPnlMicros: valuation.openPnlMicros ?? state.pnl.openPnlMicros,
                dayPnlMicros: valuation.dayPnlMicros ?? state.pnl.dayPnlMicros,
                remainingDrawdownMicros:
                  valuation.remainingDrawdownMicros ?? state.pnl.remainingDrawdownMicros,
                openContracts: valuation.openContracts ?? state.pnl.openContracts,
              }
            : state.pnl,
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
      set({ error: err instanceof Error ? err.message : 'Failed to load trading state.' });
    } finally {
      set({ loading: false });
    }
  },

  async refreshPnl() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      set({ pnl: await tradingApi.pnl(accountId) });
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

/** Open P&L across every position, recomputed as marks change. */
export function openPnlMicros(state: TradingState): number {
  return state.positions.reduce((sum, p) => sum + p.unrealizedPnlMicros, 0);
}

export function positionFor(state: TradingState, symbol: string): ApiPosition | null {
  return state.positions.find((p) => p.symbol === symbol && p.qty !== 0) ?? null;
}

export function workingOrders(state: TradingState): ApiOrder[] {
  return state.orders.filter(
    (o) => o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED' || o.status === 'CANCEL_PENDING',
  );
}
