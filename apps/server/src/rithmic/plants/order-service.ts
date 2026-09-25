/**
 * Rithmic ORDER-plant service (Milestone 9).
 *
 * Account + trade-route discovery, order submit/modify/cancel, order-update
 * subscription, and authoritative execution-report emission with deduplication.
 * A submit whose acknowledgement is lost becomes SUBMISSION_UNKNOWN — never a
 * blind resubmit (the trading equivalent of the M8 lost-ack payout rule). Working
 * orders and executions are cached from authoritative provider notifications for
 * reconciliation snapshots.
 */
import type { ExecutionReport, ExternalOrderSnapshot, ExternalSubmitInput } from '../../execution/external-provider.js';
import type { ExternalOrderState } from '@atlas/contracts';
import type { RithmicPlant } from './plant.js';
import { rithmicCodec, type RithmicCodec } from '../protocol/codec.js';
import { buildNewOrder, executionDedupKey, mapExchangeNotification, mapRithmicNotification } from '../domain/order-normalize.js';
import { rithmicMetrics } from '../metrics.js';

export interface RithmicAccount {
  readonly fcmId: string;
  readonly ibId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly currency: string;
}

export interface RithmicTradeRoute {
  readonly fcmId: string;
  readonly ibId: string;
  readonly exchange: string;
  readonly tradeRoute: string;
  readonly isDefault: boolean;
  readonly status: string;
}

export type SubmitState = 'SUBMITTED' | 'REJECTED' | 'SUBMISSION_UNKNOWN';

export interface SubmitResult {
  readonly atlasOrderId: string;
  readonly clientOrderId: string;
  readonly providerOrderId: string | null;
  readonly state: SubmitState;
  readonly reason?: string;
}

export type ExecutionReportListener = (r: ExecutionReport) => void;

export class RithmicOrderService {
  private readonly codec: RithmicCodec;
  private accounts: RithmicAccount[] = [];
  private routes: RithmicTradeRoute[] = [];
  private readonly working = new Map<string, ExternalOrderSnapshot>(); // basketId -> snapshot
  private readonly tagToBasket = new Map<string, string>(); // clientOrderId -> basketId
  private readonly basketToAtlas = new Map<string, string>(); // basketId -> atlasOrderId
  private readonly seenExec = new Set<string>();
  private readonly listeners = new Set<ExecutionReportListener>();
  private routerUnsub: Array<() => void> = [];

  constructor(private plant: RithmicPlant) {
    this.codec = rithmicCodec();
    this.attach(plant);
  }

  private attach(plant: RithmicPlant): void {
    this.routerUnsub.forEach((u) => u());
    this.routerUnsub = [
      plant.router.on('ExchangeOrderNotification', (m) => this.onExchangeNotification(m.message)),
      plant.router.on('RithmicOrderNotification', (m) => this.onRithmicNotification(m.message)),
    ];
  }

  onReport(l: ExecutionReportListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // -- discovery --------------------------------------------------------------
  async discoverAccounts(fcmId = '', ibId = ''): Promise<RithmicAccount[]> {
    const acc: RithmicAccount[] = [];
    await this.collect('RequestAccountList', { fcm_id: fcmId, ib_id: ibId, user_type: 'USER_TYPE_TRADER', user_msg: ['acct'] }, 'ResponseAccountList', (msg) => {
      const id = String(msg['account_id'] ?? '');
      if (id) acc.push({ fcmId: String(msg['fcm_id'] ?? ''), ibId: String(msg['ib_id'] ?? ''), accountId: id, accountName: String(msg['account_name'] ?? id), currency: String(msg['account_currency'] ?? 'USD') });
    });
    this.accounts = acc;
    return acc;
  }

  async discoverTradeRoutes(): Promise<RithmicTradeRoute[]> {
    const routes: RithmicTradeRoute[] = [];
    await this.collect('RequestTradeRoutes', { subscribe_for_updates: 'false', user_msg: ['routes'] }, 'ResponseTradeRoutes', (msg) => {
      const tr = String(msg['trade_route'] ?? '');
      if (tr) routes.push({ fcmId: String(msg['fcm_id'] ?? ''), ibId: String(msg['ib_id'] ?? ''), exchange: String(msg['exchange'] ?? ''), tradeRoute: tr, isDefault: String(msg['is_default'] ?? '') === 'true', status: String(msg['status'] ?? '') });
    });
    this.routes = routes;
    return routes;
  }

  /** The trade route to use for an exchange: the default if present, else the first. */
  routeFor(exchange: string): RithmicTradeRoute | null {
    const forExch = this.routes.filter((r) => r.exchange.toUpperCase() === exchange.toUpperCase());
    return forExch.find((r) => r.isDefault) ?? forExch[0] ?? this.routes.find((r) => r.isDefault) ?? this.routes[0] ?? null;
  }

  getAccounts(): readonly RithmicAccount[] { return this.accounts; }
  getRoutes(): readonly RithmicTradeRoute[] { return this.routes; }

  async subscribeOrderUpdates(account: RithmicAccount): Promise<void> {
    this.plant.send('RequestSubscribeForOrderUpdates', { fcm_id: account.fcmId, ib_id: account.ibId, account_id: account.accountId, user_msg: ['ou'] });
  }

  /**
   * A generic collect-until-terminator helper: send a request and gather rows from
   * the response stream until a message with rp_code and no row payload, or timeout.
   */
  private collect(reqName: string, payload: Record<string, unknown>, respName: string, onRow: (msg: Record<string, unknown>) => void, timeoutMs = 15_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (): void => { off(); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      const off = this.plant.router.on(respName, (m) => {
        const msg = m.message;
        if (!msg) return;
        // A terminator carries rp_code but no primary id row.
        const hasRow = respName === 'ResponseAccountList' ? !!msg['account_id'] : respName === 'ResponseTradeRoutes' ? !!msg['trade_route'] : true;
        if (hasRow) onRow(msg);
        const rp = msg['rp_code'];
        if (!hasRow && rp !== undefined) done();
      });
      try { this.plant.send(reqName, payload); } catch (e) { clearTimeout(timer); off(); reject(e as Error); }
    });
  }

  // -- submit / modify / cancel ----------------------------------------------
  /**
   * Submit an order. Returns SUBMITTED (basket id known), REJECTED (hard), or
   * SUBMISSION_UNKNOWN (ack lost — reconcile, NEVER resubmit blindly). The
   * clientOrderId (user_tag) is the stable idempotency/correlation key.
   */
  async submit(input: ExternalSubmitInput, ctx: { fcmId: string; ibId: string; providerAccountId: string; exchange: string; tradeRoute: string }, timeoutMs = 12_000): Promise<SubmitResult> {
    this.basketToAtlasByTag(input.clientOrderId, input.atlasOrderId);
    const payload = buildNewOrder(this.codec, input, ctx);
    rithmicMetrics.inc('orders_submitted');
    return new Promise<SubmitResult>((resolve) => {
      let settled = false;
      const finish = (r: SubmitResult): void => {
        if (settled) return; settled = true; off(); clearTimeout(timer);
        if (r.state === 'SUBMITTED') rithmicMetrics.inc('order_acks');
        else if (r.state === 'REJECTED') rithmicMetrics.inc('order_rejects');
        else rithmicMetrics.inc('unknown_submissions');
        resolve(r);
      };
      const timer = setTimeout(() => finish({ atlasOrderId: input.atlasOrderId, clientOrderId: input.clientOrderId, providerOrderId: null, state: 'SUBMISSION_UNKNOWN', reason: 'no acknowledgement within timeout' }), timeoutMs);
      const off = this.plant.router.on('ResponseNewOrder', (m) => {
        const msg = m.message; if (!msg) return;
        const tag = firstUserMsg(msg);
        // Only settle for our order (matched by echoed user_tag when present).
        if (tag && tag !== input.clientOrderId) return;
        const rp = firstRp(msg);
        if (rp === '0' || rp === null) {
          const basket = String(msg['basket_id'] ?? '');
          if (basket) { this.tagToBasket.set(input.clientOrderId, basket); this.basketToAtlas.set(basket, input.atlasOrderId); }
          finish({ atlasOrderId: input.atlasOrderId, clientOrderId: input.clientOrderId, providerOrderId: basket || null, state: 'SUBMITTED' });
        } else {
          finish({ atlasOrderId: input.atlasOrderId, clientOrderId: input.clientOrderId, providerOrderId: null, state: 'REJECTED', reason: `rp_code=${rp}` });
        }
      });
      try { this.plant.send('RequestNewOrder', payload); } catch { finish({ atlasOrderId: input.atlasOrderId, clientOrderId: input.clientOrderId, providerOrderId: null, state: 'SUBMISSION_UNKNOWN', reason: 'send failed' }); }
    });
  }

  private basketToAtlasByTag(_tag: string, _atlas: string): void { /* reserved for tag→atlas pre-map */ }

  async cancel(basketId: string, providerAccountId: string): Promise<void> {
    const manualOrAuto = this.codec.enumValue('RequestNewOrder', 'OrderPlacement', 'AUTO');
    rithmicMetrics.inc('order_cancels');
    this.plant.send('RequestCancelOrder', { basket_id: basketId, account_id: providerAccountId, manual_or_auto: manualOrAuto, user_msg: ['cxl'] });
  }

  async modify(basketId: string, providerAccountId: string, patch: { qty?: number; limitPrice?: number | null; stopPrice?: number | null; exchange: string }): Promise<void> {
    const manualOrAuto = this.codec.enumValue('RequestNewOrder', 'OrderPlacement', 'AUTO');
    rithmicMetrics.inc('order_modifies');
    const payload: Record<string, unknown> = { basket_id: basketId, account_id: providerAccountId, exchange: patch.exchange, manual_or_auto: manualOrAuto, user_msg: ['mod'] };
    if (patch.qty != null) payload['quantity'] = patch.qty;
    if (patch.limitPrice != null) payload['price'] = patch.limitPrice;
    if (patch.stopPrice != null) payload['trigger_price'] = patch.stopPrice;
    this.plant.send('RequestModifyOrder', payload);
  }

  // -- notifications → execution reports --------------------------------------
  private onExchangeNotification(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    const basket = String(msg['basket_id'] ?? '');
    const atlasId = this.basketToAtlas.get(basket) ?? null;
    const report = mapExchangeNotification(this.codec, msg, atlasId);
    // Deduplicate fills so an execution never applies twice.
    const notifyType = Number(msg['notify_type']);
    const isFill = report.lastFillQty > 0 || report.state === 'FILLED' || report.state === 'PARTIALLY_FILLED';
    if (isFill) {
      const key = executionDedupKey(msg);
      if (this.seenExec.has(key)) { rithmicMetrics.inc('duplicate_executions_ignored'); return; }
      this.seenExec.add(key);
      rithmicMetrics.inc('fills');
    }
    this.updateWorking(basket, report);
    void notifyType;
    for (const l of this.listeners) { try { l(report); } catch { /* isolate */ } }
  }

  private onRithmicNotification(msg: Record<string, unknown> | null): void {
    if (!msg) return;
    const basket = String(msg['basket_id'] ?? '');
    const atlasId = this.basketToAtlas.get(basket) ?? null;
    const report = mapRithmicNotification(this.codec, msg, atlasId);
    this.updateWorking(basket, report);
    for (const l of this.listeners) { try { l(report); } catch { /* isolate */ } }
  }

  private updateWorking(basket: string, report: ExecutionReport): void {
    if (!basket) return;
    if (report.state === 'CANCELED' || report.state === 'REJECTED' || report.state === 'FILLED') {
      this.working.delete(basket);
      return;
    }
    const prev = this.working.get(basket);
    this.working.set(basket, {
      providerOrderId: basket,
      symbol: prev?.symbol ?? '',
      side: prev?.side ?? 'BUY',
      qty: prev?.qty ?? 0,
      filledQty: report.filledQty,
      state: report.state as ExternalOrderState,
    });
  }

  /** Provider-derived working-order snapshot (from authoritative notifications). */
  listWorkingOrders(): ExternalOrderSnapshot[] {
    return [...this.working.values()];
  }

  /** Resolve the basket id for a lost-ack submission, for reconciliation. */
  basketForClientOrder(clientOrderId: string): string | null {
    return this.tagToBasket.get(clientOrderId) ?? null;
  }

  dispose(): void {
    this.routerUnsub.forEach((u) => u());
    this.routerUnsub = [];
    this.listeners.clear();
  }
}

function firstRp(msg: Record<string, unknown>): string | null {
  const rp = msg['rp_code'];
  if (Array.isArray(rp) && rp.length > 0) return String(rp[0]);
  if (typeof rp === 'string') return rp;
  return null;
}
function firstUserMsg(msg: Record<string, unknown>): string | null {
  const um = msg['user_msg'];
  if (Array.isArray(um) && um.length > 0) return String(um[0]);
  if (typeof um === 'string' && um) return um;
  return null;
}
