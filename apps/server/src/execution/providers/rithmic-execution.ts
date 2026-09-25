/**
 * Rithmic execution adapter (Milestone 9).
 *
 * Implements the Atlas `ExternalExecutionAdapter` seam over the real R | Protocol
 * ORDER + PNL plants. Atlas order ids stay canonical; a provider ack is not a
 * fill; a lost acknowledgement becomes an UNKNOWN submission that MUST be
 * reconciled, never blindly resubmitted. It is only reachable when Rithmic is
 * enabled AND execution is enabled AND credentials are configured; otherwise it
 * stays honestly UNCONFIGURED and every op throws a structured, secret-free error.
 * The transport factory is injectable so the whole path is testable without a
 * network; production defaults to the real WebSocket transport.
 */
import type {
  ExecutionProviderKind,
  ProviderConfigState,
  ProviderHealthSnapshot,
  ProviderHealthState,
} from '@atlas/contracts';
import {
  ExternalExecutionError,
  type ExecutionReportListener,
  type ExternalAck,
  type ExternalExecutionAdapter,
  type ExternalExecutionCapabilities,
  type ExternalOrderSnapshot,
  type ExternalPositionSnapshot,
  type ExternalSubmitInput,
} from '../external-provider.js';
import { redactedRithmicDescription, resolveRithmicConnection } from '../../infra/rithmic-config.js';
import { RithmicConnectionManager } from '../../rithmic/plants/connection-manager.js';
import { RithmicOrderService, type RithmicAccount } from '../../rithmic/plants/order-service.js';
import { RithmicPnlService } from '../../rithmic/plants/pnl-service.js';
import { WsRithmicTransport } from '../../rithmic/transport/ws-transport.js';
import type { TransportFactory } from '../../rithmic/transport/transport.js';
import { rithmicExchange, isLaunchRoot } from '../../rithmic/domain/instruments.js';

export class RithmicExecutionProvider implements ExternalExecutionAdapter {
  readonly id = 'rithmic-exec';
  readonly kind: ExecutionProviderKind = 'rithmic';

  private manager: RithmicConnectionManager | null = null;
  private orders: RithmicOrderService | null = null;
  private pnl: RithmicPnlService | null = null;
  private lastError: string | null = null;
  private lastConnectAt: number | null = null;
  private lastDisconnectAt: number | null = null;
  private readonly reportListeners = new Set<ExecutionReportListener>();
  private readonly basketByProviderId = new Map<string, string>();

  constructor(private readonly transportFactory: TransportFactory = (url) => new WsRithmicTransport(url)) {}

  configState(): ProviderConfigState {
    return resolveRithmicConnection().ok ? 'CONFIGURED' : 'UNCONFIGURED';
  }

  capabilities(): ExternalExecutionCapabilities {
    return {
      supportsMarketOrders: true,
      supportsLimitOrders: true,
      supportsStopOrders: true,
      supportsModify: true,
      supportsCancel: true,
      supportsReconciliationSnapshot: true,
    };
  }

  health(): ProviderHealthState {
    if (this.configState() === 'UNCONFIGURED') return 'UNCONFIGURED';
    if (!this.manager) return 'DISCONNECTED';
    return this.manager.allHealthy() ? 'CONNECTED' : 'DEGRADED';
  }

  healthSnapshot(): ProviderHealthSnapshot {
    const orderPlant = this.manager?.plant('ORDER');
    const m = orderPlant?.getMetrics();
    return {
      providerId: this.id,
      role: 'EXECUTION',
      kind: this.kind,
      configState: this.configState(),
      health: this.health(),
      isSimulation: false,
      detail: redactedRithmicDescription(),
      lastConnectAt: this.lastConnectAt,
      lastDisconnectAt: this.lastDisconnectAt,
      lastMessageAt: m?.lastMessageAt ?? null,
      lastHeartbeatAt: m?.lastHeartbeatReceivedAt ?? null,
      reconnectCount: m?.reconnectCount ?? 0,
      subscriptionCount: this.orders?.getAccounts().length ?? 0,
      lastError: this.lastError,
    };
  }

  async connect(): Promise<void> {
    const r = resolveRithmicConnection();
    if (!r.ok) { this.lastError = r.reason; throw new ExternalExecutionError('PROVIDER_UNCONFIGURED', `Rithmic execution is not configured (${r.reason}).`); }
    if (!r.connection.executionEnabled) {
      this.lastError = 'RITHMIC_EXECUTION_ENABLED is false';
      throw new ExternalExecutionError('NOT_SUPPORTED', 'Rithmic execution is not enabled (RITHMIC_EXECUTION_ENABLED=false).');
    }
    const c = r.connection;
    const mgr = new RithmicConnectionManager({
      endpoint: c.endpoint,
      systemName: c.systemName,
      login: { user: c.credentials!.user, password: c.credentials!.password, appName: c.appName, appVersion: c.appVersion },
      plants: ['ORDER', 'PNL'],
      transportFactory: this.transportFactory,
      onPlantAuthenticated: async (kind) => {
        if (kind === 'ORDER' && this.orders) {
          // Re-subscribe order updates + re-discover on reconnect.
          for (const a of this.orders.getAccounts()) await this.orders.subscribeOrderUpdates(a).catch(() => undefined);
        }
      },
    }, c.environment);
    await mgr.start();
    this.manager = mgr;
    this.lastConnectAt = Date.now();
    const orderPlant = mgr.plant('ORDER')!;
    const pnlPlant = mgr.plant('PNL') ?? null;
    const orders = new RithmicOrderService(orderPlant);
    orders.onReport((rep) => { for (const l of this.reportListeners) { try { l(rep); } catch { /* isolate */ } } });
    this.orders = orders;
    await orders.discoverAccounts(c.credentials ? '' : '');
    await orders.discoverTradeRoutes();
    for (const a of orders.getAccounts()) await orders.subscribeOrderUpdates(a).catch(() => undefined);
    if (pnlPlant) {
      const pnl = new RithmicPnlService(pnlPlant);
      this.pnl = pnl;
      for (const a of orders.getAccounts()) await pnl.subscribe(a).catch(() => undefined);
    }
  }

  async disconnect(): Promise<void> {
    this.lastDisconnectAt = Date.now();
    this.orders?.dispose();
    this.pnl?.dispose();
    this.manager?.stop();
    this.orders = null; this.pnl = null; this.manager = null;
  }

  private accountFor(providerAccountId: string): RithmicAccount | null {
    return this.orders?.getAccounts().find((a) => a.accountId === providerAccountId) ?? this.orders?.getAccounts()[0] ?? null;
  }

  async submit(input: ExternalSubmitInput): Promise<ExternalAck> {
    if (!this.orders) this.notReady();
    const root = (input.contractCode ?? input.symbol).replace(/[FGHJKMNQUVXZ]\d+$/i, '');
    const exchange = isLaunchRoot(root) ? rithmicExchange(root) : 'CME';
    const account = this.accountFor(input.providerAccountId);
    if (!account) throw new ExternalExecutionError('REJECTED', 'no mapped Rithmic account for this order');
    const route = this.orders!.routeFor(exchange);
    if (!route) throw new ExternalExecutionError('REJECTED', `no trade route for ${exchange}`);
    const result = await this.orders!.submit(input, {
      fcmId: account.fcmId, ibId: account.ibId, providerAccountId: account.accountId, exchange, tradeRoute: route.tradeRoute,
    });
    if (result.state === 'REJECTED') {
      throw new ExternalExecutionError('REJECTED', `Rithmic rejected the order (${result.reason ?? 'unknown'})`);
    }
    if (result.providerOrderId) this.basketByProviderId.set(result.providerOrderId, input.atlasOrderId);
    // SUBMISSION_UNKNOWN is NOT a rejection — it is "we don't know". The caller
    // reconciles; it must never blindly resubmit.
    return {
      atlasOrderId: input.atlasOrderId,
      providerOrderId: result.providerOrderId ?? '',
      accepted: result.state === 'SUBMITTED',
      state: result.state === 'SUBMITTED' ? 'SUBMITTED' : 'UNKNOWN',
    };
  }

  async cancel(providerOrderId: string): Promise<void> {
    if (!this.orders) this.notReady();
    const account = this.orders!.getAccounts()[0];
    await this.orders!.cancel(providerOrderId, account?.accountId ?? '');
  }

  async modify(providerOrderId: string, patch: { qty?: number; limitPrice?: number | null; stopPrice?: number | null }): Promise<void> {
    if (!this.orders) this.notReady();
    const account = this.orders!.getAccounts()[0];
    await this.orders!.modify(providerOrderId, account?.accountId ?? '', { ...patch, exchange: 'CME' });
  }

  async listWorkingOrders(_providerAccountId: string): Promise<ExternalOrderSnapshot[]> {
    if (!this.orders) this.notReady();
    return this.orders!.listWorkingOrders();
  }

  async listPositions(_providerAccountId: string): Promise<ExternalPositionSnapshot[]> {
    if (!this.orders) this.notReady();
    return this.pnl?.listPositions() ?? [];
  }

  onReport(listener: ExecutionReportListener): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  private notReady(): never {
    if (this.configState() === 'UNCONFIGURED') {
      throw new ExternalExecutionError('PROVIDER_UNCONFIGURED', 'Rithmic execution is not configured.');
    }
    throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'Rithmic execution is not connected.');
  }
}
