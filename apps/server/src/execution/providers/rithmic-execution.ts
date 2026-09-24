/**
 * Rithmic execution adapter — HONEST SCAFFOLD (M4-D).
 *
 * Implements the Atlas `ExternalExecutionAdapter` seam so an account could one
 * day be routed to Rithmic without touching the terminal, risk engine, account
 * system or copy trading. It DOES NOT connect to Rithmic: the real R | Protocol
 * wire integration requires the official dev kit / protocol spec, credentials, a
 * broker/FCM relationship and conformance — none of which exist here (see
 * docs/rithmic-integration-readiness-v1.md).
 *
 * Therefore, honestly:
 *  - Without complete server-side config, `configState()` is UNCONFIGURED and
 *    every operational method throws a structured PROVIDER_UNCONFIGURED error.
 *  - With config present, `connect()` reaches a clearly-marked integration seam
 *    that throws NOT_SUPPORTED — it never fakes a CONNECTED state.
 *  - Credentials never appear in logs, errors, health, or API output.
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
import {
  redactedRithmicDescription,
  resolveRithmicConfig,
} from '../../infra/rithmic-config.js';
import { HeartbeatWatchdog } from '../../infra/connection-lifecycle.js';

export class RithmicExecutionProvider implements ExternalExecutionAdapter {
  readonly id = 'rithmic-exec';
  readonly kind: ExecutionProviderKind = 'rithmic';

  private health_: ProviderHealthState = 'UNCONFIGURED';
  private lastConnectAt: number | null = null;
  private lastDisconnectAt: number | null = null;
  private reconnectCount = 0;
  private lastError: string | null = null;
  private readonly watchdog = new HeartbeatWatchdog(30_000);

  configState(): ProviderConfigState {
    return resolveRithmicConfig().state === 'CONFIGURED' ? 'CONFIGURED' : 'UNCONFIGURED';
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
    return this.configState() === 'UNCONFIGURED' ? 'UNCONFIGURED' : this.health_;
  }

  healthSnapshot(): ProviderHealthSnapshot {
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
      lastMessageAt: null,
      lastHeartbeatAt: this.watchdog.lastBeat(),
      reconnectCount: this.reconnectCount,
      subscriptionCount: 0,
      lastError: this.lastError,
    };
  }

  async connect(): Promise<void> {
    const cfg = resolveRithmicConfig();
    if (cfg.state === 'UNCONFIGURED') {
      this.health_ = 'UNCONFIGURED';
      this.lastError = `unconfigured (missing: ${cfg.missing.join(', ')})`;
      throw new ExternalExecutionError('PROVIDER_UNCONFIGURED', 'Rithmic execution is not configured.');
    }
    // ── Integration seam ──────────────────────────────────────────────────
    // The real R | Protocol login (RSSL handshake, system/gateway selection,
    // trade-route + order-plant subscription) goes here, against the official
    // dev kit. It cannot be exercised without the kit + credentials + FCM, so
    // this refuses honestly rather than pretending to connect.
    this.health_ = 'ERROR';
    this.lastError = 'R | Protocol dev kit not integrated';
    throw new ExternalExecutionError(
      'NOT_SUPPORTED',
      'Rithmic wire protocol is not integrated in this build (requires dev kit + credentials + FCM).',
    );
  }

  async disconnect(): Promise<void> {
    this.lastDisconnectAt = Date.now();
    this.health_ = this.configState() === 'UNCONFIGURED' ? 'UNCONFIGURED' : 'DISCONNECTED';
    this.watchdog.reset();
  }

  private notReady(): never {
    if (this.configState() === 'UNCONFIGURED') {
      throw new ExternalExecutionError('PROVIDER_UNCONFIGURED', 'Rithmic execution is not configured.');
    }
    throw new ExternalExecutionError('PROVIDER_DISCONNECTED', 'Rithmic execution is not connected.');
  }

  async submit(_input: ExternalSubmitInput): Promise<ExternalAck> {
    this.notReady();
  }
  async cancel(_providerOrderId: string): Promise<void> {
    this.notReady();
  }
  async modify(): Promise<void> {
    this.notReady();
  }
  async listWorkingOrders(_providerAccountId: string): Promise<ExternalOrderSnapshot[]> {
    this.notReady();
  }
  async listPositions(_providerAccountId: string): Promise<ExternalPositionSnapshot[]> {
    this.notReady();
  }

  onReport(_listener: ExecutionReportListener): () => void {
    // No reports are ever emitted by the scaffold; return a no-op unsubscribe.
    return () => undefined;
  }
}
