/**
 * Scripted external execution adapter — TEST DOUBLE (M4-W).
 *
 * A deterministic, fully controllable `ExternalExecutionAdapter` for proving
 * production external-execution semantics without any real venue or credentials:
 * ack vs no-ack (lost acknowledgement), partial + late fills, rejects, duplicate
 * reports, reconnect, and reconciliation snapshots that deliberately disagree
 * with Atlas. This is NOT a production adapter — it never touches a network.
 */
import type {
  ExecutionProviderKind,
  ProviderConfigState,
  ProviderHealthSnapshot,
  ProviderHealthState,
} from '@atlas/contracts';
import {
  ExternalExecutionError,
  type ExecutionReport,
  type ExecutionReportListener,
  type ExternalAck,
  type ExternalExecutionAdapter,
  type ExternalExecutionCapabilities,
  type ExternalOrderSnapshot,
  type ExternalPositionSnapshot,
  type ExternalSubmitInput,
} from '../external-provider.js';

/** How the double should behave for the next submit. */
export interface ScriptedSubmitBehavior {
  /** Reject the submit synchronously with a structured error. */
  readonly reject?: boolean;
  /** Throw a TIMEOUT (the caller does not learn whether the venue got it). */
  readonly timeout?: boolean;
  /** Accept the transport but NEVER emit any report (lost acknowledgement). */
  readonly lostAck?: boolean;
  /** Fill this many now, as a PARTIALLY_FILLED/FILLED report, at this price. */
  readonly fillNowQty?: number;
  readonly fillPrice?: number;
}

export class ScriptedExecutionProvider implements ExternalExecutionAdapter {
  readonly id = 'scripted-exec';
  readonly kind: ExecutionProviderKind = 'scripted';

  private connected = false;
  private health_: ProviderHealthState = 'DISCONNECTED';
  private seq = 0;
  private reconnectCount = 0;
  private lastConnectAt: number | null = null;
  private lastDisconnectAt: number | null = null;
  private readonly listeners = new Set<ExecutionReportListener>();
  private readonly byClientOrderId = new Map<string, string>(); // idempotency
  private readonly orders = new Map<string, ExternalOrderSnapshot>();
  private positions: ExternalPositionSnapshot[] = [];
  private nextBehavior: ScriptedSubmitBehavior = {};

  configState(): ProviderConfigState {
    return 'CONFIGURED'; // the test double is always "configured"
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
    return this.health_;
  }
  healthSnapshot(): ProviderHealthSnapshot {
    return {
      providerId: this.id,
      role: 'EXECUTION',
      kind: this.kind,
      configState: 'CONFIGURED',
      health: this.health_,
      isSimulation: false,
      detail: 'scripted test execution double',
      lastConnectAt: this.lastConnectAt,
      lastDisconnectAt: this.lastDisconnectAt,
      lastMessageAt: null,
      lastHeartbeatAt: null,
      reconnectCount: this.reconnectCount,
      subscriptionCount: this.orders.size,
      lastError: null,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) this.reconnectCount += 1;
    this.connected = true;
    this.health_ = 'CONNECTED';
    this.lastConnectAt = Date.now();
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.health_ = 'DISCONNECTED';
    this.lastDisconnectAt = Date.now();
  }

  // ── test controls ───────────────────────────────────────────────────────
  /** Program the behavior of the NEXT submit. */
  program(behavior: ScriptedSubmitBehavior): void {
    this.nextBehavior = behavior;
  }
  /** Set the venue's authoritative working-order/position snapshot (reconciliation). */
  setSnapshot(orders: ExternalOrderSnapshot[], positions: ExternalPositionSnapshot[]): void {
    this.orders.clear();
    for (const o of orders) this.orders.set(o.providerOrderId, o);
    this.positions = positions;
  }
  /** Emit an arbitrary async report to all listeners (e.g. a late or duplicate fill). */
  emit(report: ExecutionReport): void {
    for (const l of this.listeners) l(report);
  }

  async submit(input: ExternalSubmitInput): Promise<ExternalAck> {
    if (!this.connected) {
      throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'scripted venue disconnected', true);
    }
    const behavior = this.nextBehavior;
    this.nextBehavior = {};

    // Idempotency: a retried clientOrderId returns the SAME providerOrderId and
    // does not create a second venue order.
    const existing = this.byClientOrderId.get(input.clientOrderId);
    if (existing) {
      return { atlasOrderId: input.atlasOrderId, providerOrderId: existing, accepted: true, state: 'ACKNOWLEDGED' };
    }

    if (behavior.timeout) {
      // The venue may or may not have received it — the caller genuinely does
      // not know. Nothing is recorded here on purpose.
      throw new ExternalExecutionError('TIMEOUT', 'scripted submit timed out', true);
    }
    if (behavior.reject) {
      return { atlasOrderId: input.atlasOrderId, providerOrderId: '', accepted: false, state: 'REJECTED' };
    }

    this.seq += 1;
    const providerOrderId = `SX-${this.seq}`;
    this.byClientOrderId.set(input.clientOrderId, providerOrderId);
    this.orders.set(providerOrderId, {
      providerOrderId,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      filledQty: 0,
      state: 'ACKNOWLEDGED',
    });

    if (behavior.lostAck) {
      // Accepted by the transport, but NO report will ever arrive. Atlas must
      // discover the truth via reconciliation.
      return { atlasOrderId: input.atlasOrderId, providerOrderId, accepted: true, state: 'SUBMITTED' };
    }

    // Default: acknowledge, then optionally emit a fill.
    const ack: ExternalAck = { atlasOrderId: input.atlasOrderId, providerOrderId, accepted: true, state: 'ACKNOWLEDGED' };
    if (behavior.fillNowQty && behavior.fillNowQty > 0) {
      const filled = Math.min(behavior.fillNowQty, input.qty);
      const state = filled >= input.qty ? 'FILLED' : 'PARTIALLY_FILLED';
      this.orders.set(providerOrderId, { ...this.orders.get(providerOrderId)!, filledQty: filled, state });
      this.emit({
        providerOrderId,
        atlasOrderId: input.atlasOrderId,
        state,
        filledQty: filled,
        lastFillQty: filled,
        avgFillPrice: behavior.fillPrice ?? null,
        providerStatus: state,
        eventTs: Date.now(),
      });
    }
    return ack;
  }

  async cancel(providerOrderId: string): Promise<void> {
    if (!this.connected) throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'disconnected', true);
    const o = this.orders.get(providerOrderId);
    if (o) this.orders.set(providerOrderId, { ...o, state: 'CANCELED' });
  }
  async modify(): Promise<void> {
    if (!this.connected) throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'disconnected', true);
  }

  async listWorkingOrders(): Promise<ExternalOrderSnapshot[]> {
    if (!this.connected) throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'disconnected', true);
    return [...this.orders.values()].filter((o) => o.state !== 'CANCELED' && o.state !== 'FILLED');
  }
  async listPositions(): Promise<ExternalPositionSnapshot[]> {
    if (!this.connected) throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'disconnected', true);
    return this.positions;
  }

  onReport(listener: ExecutionReportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
