/**
 * Rithmic execution — deterministic tests (Milestone 9).
 *
 * Account/route discovery, order submit/modify/cancel, order-update + fill
 * normalization, execution dedup, lost-ack (SUBMISSION_UNKNOWN) safety, and the
 * ExternalExecutionAdapter — all against the test-double codec, no live Rithmic.
 */
// Enable the execution path with mock-injectable transport (no network).
process.env['RITHMIC_ENABLED'] = 'true';
process.env['RITHMIC_ENDPOINT'] = 'wss://mock.rithmic.test:443';
process.env['RITHMIC_SYSTEM_NAME'] = 'Rithmic Test';
process.env['RITHMIC_USER'] = 'exec-user';
process.env['RITHMIC_PASSWORD'] = 'exec-secret-pw';
process.env['RITHMIC_EXECUTION_ENABLED'] = 'true';

import { describe, expect, it, beforeEach } from 'vitest';
import { loadSchema, resetSchemaCache } from '../protocol/registry.js';
import { rithmicCodec, resetCodec, type RithmicCodec } from '../protocol/codec.js';
import { MockRithmicTransport } from '../transport/transport.js';
import { RithmicPlant } from './plant.js';
import { RithmicOrderService } from './order-service.js';
import { buildNewOrder, executionDedupKey, mapExchangeNotification } from '../domain/order-normalize.js';
import { RithmicExecutionProvider } from '../../execution/providers/rithmic-execution.js';
import { ExternalExecutionError, type ExternalSubmitInput } from '../../execution/external-provider.js';

let codec: RithmicCodec;
beforeEach(() => { resetSchemaCache(); resetCodec(); codec = rithmicCodec(); loadSchema({ force: true }); });

/** A mock ORDER-plant server. Set `ackOrders=false` to simulate a lost ack. */
function mockOrderServer(opts: { ackOrders?: boolean; rejectOrders?: boolean; accounts?: string[]; routes?: Array<{ exchange: string; route: string; def: boolean }> } = {}) {
  const transports: MockRithmicTransport[] = [];
  const ack = opts.ackOrders !== false;
  const factory = (url: string): MockRithmicTransport => {
    const t = new MockRithmicTransport(url);
    t.serverHandler = (frame): void => {
      let d; try { d = codec.decode(frame); } catch { return; }
      const echo = (d.message?.['user_msg'] as string[] | undefined) ?? [];
      if (d.name === 'RequestLogin') t.injectMessage(codec.encode('ResponseLogin', { rp_code: ['0'], user_msg: echo, heartbeat_interval: 60 }));
      else if (d.name === 'RequestRithmicSystemInfo') t.injectMessage(codec.encode('ResponseRithmicSystemInfo', { rp_code: ['0'], system_name: ['Rithmic Test'], user_msg: echo }));
      else if (d.name === 'RequestAccountList') {
        for (const a of (opts.accounts ?? ['ACC-1'])) t.injectMessage(codec.encode('ResponseAccountList', { rp_code: ['0'], fcm_id: 'FCM', ib_id: 'IB', account_id: a, account_name: a, account_currency: 'USD', user_msg: echo }));
        t.injectMessage(codec.encode('ResponseAccountList', { rp_code: ['0'], user_msg: echo }));
      } else if (d.name === 'RequestTradeRoutes') {
        for (const r of (opts.routes ?? [{ exchange: 'CME', route: 'globex', def: true }])) t.injectMessage(codec.encode('ResponseTradeRoutes', { rp_code: ['0'], fcm_id: 'FCM', ib_id: 'IB', exchange: r.exchange, trade_route: r.route, is_default: r.def ? 'true' : 'false', status: 'up', user_msg: echo }));
        t.injectMessage(codec.encode('ResponseTradeRoutes', { rp_code: ['0'], user_msg: echo }));
      } else if (d.name === 'RequestNewOrder') {
        if (!ack) return; // lost ack
        const tag = echo[0] ?? 'tag';
        if (opts.rejectOrders) t.injectMessage(codec.encode('ResponseNewOrder', { rp_code: ['5', 'risk rejected'], user_msg: [tag] }));
        else t.injectMessage(codec.encode('ResponseNewOrder', { rp_code: ['0'], basket_id: `BK-${tag}`, user_msg: [tag] }));
      }
      // cancel/modify/subscribe: no synchronous response needed for these tests.
    };
    transports.push(t);
    return t;
  };
  return { factory, transports };
}

async function orderPlant(factory: (u: string) => MockRithmicTransport): Promise<RithmicPlant> {
  const p = new RithmicPlant({ kind: 'ORDER', url: 'wss://m/o', transportFactory: factory, login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' } });
  await p.start();
  return p;
}

const submitInput = (over: Partial<ExternalSubmitInput> = {}): ExternalSubmitInput => ({
  atlasOrderId: 'atlas-1', clientOrderId: 'cli-1', providerAccountId: 'ACC-1', symbol: 'NQ', contractCode: 'NQZ5',
  side: 'BUY', qty: 1, type: 'LIMIT', limitPrice: 20000, stopPrice: null, ...over,
});

describe('order normalization', () => {
  it('builds a RequestNewOrder with schema-resolved enums and quantity_64', () => {
    const p = buildNewOrder(codec, submitInput(), { fcmId: 'F', ibId: 'I', providerAccountId: 'ACC-1', exchange: 'CME', tradeRoute: 'globex' });
    expect(p['transaction_type']).toBe(codec.enumValue('RequestNewOrder', 'TransactionType', 'BUY'));
    expect(p['price_type']).toBe(codec.enumValue('RequestNewOrder', 'PriceType', 'LIMIT'));
    expect(p['manual_or_auto']).toBe(codec.enumValue('RequestNewOrder', 'OrderPlacement', 'AUTO'));
    expect(p['quantity_64']).toBe(1);
    expect(p['price']).toBe(20000);
    expect(p['user_tag']).toBe('cli-1');
  });

  it('maps a FILL notification to FILLED / PARTIALLY_FILLED by unfilled size', () => {
    const nt = codec.enumValue('ExchangeOrderNotification', 'NotifyType', 'FILL');
    const partial = mapExchangeNotification(codec, { notify_type: nt, basket_id: 'BK', fill_size: 1, total_fill_size: 1, total_unfilled_size: 1, fill_price: 20000, ssboe: 1, usecs: 0 }, 'atlas-1');
    expect(partial.state).toBe('PARTIALLY_FILLED');
    expect(partial.lastFillQty).toBe(1);
    const full = mapExchangeNotification(codec, { notify_type: nt, basket_id: 'BK', fill_size: 1, total_fill_size: 2, total_unfilled_size: 0, fill_price: 20000, ssboe: 1, usecs: 1 }, 'atlas-1');
    expect(full.state).toBe('FILLED');
  });

  it('maps a REJECT notification to REJECTED', () => {
    const nt = codec.enumValue('ExchangeOrderNotification', 'NotifyType', 'REJECT');
    expect(mapExchangeNotification(codec, { notify_type: nt, basket_id: 'BK' }, null).state).toBe('REJECTED');
  });

  it('executionDedupKey is stable for the same fill and differs across fills', () => {
    const a = executionDedupKey({ basket_id: 'BK', trade_id: 'T1', fill_size: 1, ssboe: 1, usecs: 2 });
    const b = executionDedupKey({ basket_id: 'BK', trade_id: 'T1', fill_size: 1, ssboe: 1, usecs: 2 });
    const c = executionDedupKey({ basket_id: 'BK', trade_id: 'T2', fill_size: 1, ssboe: 1, usecs: 3 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('order service — discovery + lifecycle', () => {
  it('discovers accounts and trade routes and picks the default route', async () => {
    const { factory } = mockOrderServer({ accounts: ['ACC-1', 'ACC-2'], routes: [{ exchange: 'CME', route: 'globex', def: true }, { exchange: 'CME', route: 'alt', def: false }] });
    const plant = await orderPlant(factory);
    const svc = new RithmicOrderService(plant);
    const accts = await svc.discoverAccounts();
    expect(accts.map((a) => a.accountId)).toEqual(['ACC-1', 'ACC-2']);
    await svc.discoverTradeRoutes();
    expect(svc.routeFor('CME')!.tradeRoute).toBe('globex'); // the default
    plant.stop();
  });

  it('submits an order and gets a basket id (SUBMITTED)', async () => {
    const { factory } = mockOrderServer();
    const plant = await orderPlant(factory);
    const svc = new RithmicOrderService(plant);
    const r = await svc.submit(submitInput(), { fcmId: 'F', ibId: 'I', providerAccountId: 'ACC-1', exchange: 'CME', tradeRoute: 'globex' });
    expect(r.state).toBe('SUBMITTED');
    expect(r.providerOrderId).toBe('BK-cli-1');
    plant.stop();
  });

  it('a hard rejection is REJECTED (never retried)', async () => {
    const { factory } = mockOrderServer({ rejectOrders: true });
    const plant = await orderPlant(factory);
    const svc = new RithmicOrderService(plant);
    const r = await svc.submit(submitInput(), { fcmId: 'F', ibId: 'I', providerAccountId: 'ACC-1', exchange: 'CME', tradeRoute: 'globex' });
    expect(r.state).toBe('REJECTED');
    plant.stop();
  });

  it('a lost acknowledgement is SUBMISSION_UNKNOWN, never a blind resubmit', async () => {
    const { factory } = mockOrderServer({ ackOrders: false });
    const plant = await orderPlant(factory);
    const svc = new RithmicOrderService(plant);
    const r = await svc.submit(submitInput(), { fcmId: 'F', ibId: 'I', providerAccountId: 'ACC-1', exchange: 'CME', tradeRoute: 'globex' }, 200);
    expect(r.state).toBe('SUBMISSION_UNKNOWN');
    expect(r.providerOrderId).toBeNull();
    plant.stop();
  });

  it('emits execution reports and deduplicates a repeated fill', async () => {
    const { factory, transports } = mockOrderServer();
    const plant = await orderPlant(factory);
    const svc = new RithmicOrderService(plant);
    await svc.submit(submitInput(), { fcmId: 'F', ibId: 'I', providerAccountId: 'ACC-1', exchange: 'CME', tradeRoute: 'globex' });
    const reports: string[] = [];
    svc.onReport((r) => reports.push(r.state));
    const nt = codec.enumValue('ExchangeOrderNotification', 'NotifyType', 'FILL');
    const fill = { notify_type: nt, basket_id: 'BK-cli-1', trade_id: 'T1', fill_size: 1, total_fill_size: 1, total_unfilled_size: 0, fill_price: 20000, ssboe: 5, usecs: 5 };
    transports[0]!.injectMessage(codec.encode('ExchangeOrderNotification', fill));
    transports[0]!.injectMessage(codec.encode('ExchangeOrderNotification', fill)); // duplicate
    expect(reports.filter((s) => s === 'FILLED')).toHaveLength(1); // dedup
    plant.stop();
  });
});

describe('execution adapter', () => {
  it('is CONFIGURED and connects to discover accounts + routes', async () => {
    const { factory } = mockOrderServer();
    const p = new RithmicExecutionProvider(factory);
    expect(p.configState()).toBe('CONFIGURED');
    await p.connect();
    expect(p.health()).toBe('CONNECTED');
    const snap = p.healthSnapshot();
    expect(snap.isSimulation).toBe(false);
    expect(snap.subscriptionCount).toBeGreaterThanOrEqual(1);
    await p.disconnect();
  });

  it('submit returns an accepted ack on SUBMITTED', async () => {
    const { factory } = mockOrderServer();
    const p = new RithmicExecutionProvider(factory);
    await p.connect();
    const ack = await p.submit(submitInput());
    expect(ack.accepted).toBe(true);
    expect(ack.state).toBe('SUBMITTED');
    expect(ack.providerOrderId).toBe('BK-cli-1');
    await p.disconnect();
  });

  it('submit returns an UNKNOWN ack (not a throw) on a lost acknowledgement', async () => {
    const { factory } = mockOrderServer({ ackOrders: false });
    const p = new RithmicExecutionProvider(factory);
    await p.connect();
    // Shorten the wait by racing; the service default timeout applies but the
    // ack never comes, so we assert the eventual UNKNOWN state.
    const ack = await p.submit(submitInput());
    expect(ack.accepted).toBe(false);
    expect(ack.state).toBe('UNKNOWN');
    await p.disconnect();
  }, 20_000);

  it('submit throws a structured ExternalExecutionError on a hard reject', async () => {
    const { factory } = mockOrderServer({ rejectOrders: true });
    const p = new RithmicExecutionProvider(factory);
    await p.connect();
    await expect(p.submit(submitInput())).rejects.toBeInstanceOf(ExternalExecutionError);
    await p.disconnect();
  });

  it('exposes provider working orders for reconciliation', async () => {
    const { factory, transports } = mockOrderServer();
    const p = new RithmicExecutionProvider(factory);
    await p.connect();
    await p.submit(submitInput());
    const nt = codec.enumValue('ExchangeOrderNotification', 'NotifyType', 'STATUS');
    // Inject on the ORDER plant's transport (the one that carried RequestNewOrder).
    const orderT = transports.find((t) => t.sent.some((f) => { try { return codec.decode(f).name === 'RequestNewOrder'; } catch { return false; } }))!;
    orderT.injectMessage(codec.encode('ExchangeOrderNotification', { notify_type: nt, basket_id: 'BK-cli-1', status: 'working', total_fill_size: 0, total_unfilled_size: 1 }));
    const working = await p.listWorkingOrders('ACC-1');
    expect(working.some((w) => w.providerOrderId === 'BK-cli-1')).toBe(true);
    await p.disconnect();
  });
});
