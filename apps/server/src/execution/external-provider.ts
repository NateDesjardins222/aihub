/**
 * External execution adapter seam (M4-M / M4-N).
 *
 * The engine-shaped `ExecutionProvider` (see provider.ts) is right for the Atlas
 * SIMULATION path: it fills synchronously and returns the authoritative account
 * view. A real EXTERNAL venue is different in kind — it acknowledges and fills
 * ASYNCHRONOUSLY, an HTTP/request success is NOT an exchange acknowledgement, and
 * Atlas must be able to represent "we don't know". Atlas remains the P&L /
 * account authority; the external adapter is a venue transport that emits
 * execution reports which Atlas reconciles into its own state.
 *
 * This interface is therefore deliberately separate from the simulation seam.
 * No external adapter is enabled for customers in this milestone; the Rithmic
 * adapter is an honest UNCONFIGURED scaffold and the Scripted adapter is a test
 * double used to prove the semantics without credentials.
 */
import type {
  ExecutionProviderKind,
  ExternalOrderState,
  ProviderConfigState,
  ProviderHealthSnapshot,
  ProviderHealthState,
} from '@atlas/contracts';

/** A structured, credential-free external-execution error. Never "order failed". */
export class ExternalExecutionError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_UNCONFIGURED'
      | 'PROVIDER_DISCONNECTED'
      | 'NOT_SUPPORTED'
      | 'REJECTED'
      | 'TIMEOUT'
      | 'UNKNOWN',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ExternalExecutionError';
  }
}

/** An order intent handed to an external venue. Atlas ids are canonical. */
export interface ExternalSubmitInput {
  readonly atlasOrderId: string;
  /** Idempotency key: a retried submit with the same key must not double-order. */
  readonly clientOrderId: string;
  readonly providerAccountId: string;
  readonly symbol: string;
  readonly contractCode: string | null;
  readonly side: 'BUY' | 'SELL';
  readonly qty: number;
  readonly type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';
  readonly limitPrice?: number | null;
  readonly stopPrice?: number | null;
}

/** The synchronous transport-level acknowledgement of a submit. NOT a fill. */
export interface ExternalAck {
  readonly atlasOrderId: string;
  readonly providerOrderId: string;
  /** Accepted by the transport (queued/acknowledged), not necessarily working. */
  readonly accepted: boolean;
  readonly state: ExternalOrderState;
}

/** An asynchronous execution report from the venue (ack / fill / reject / cancel). */
export interface ExecutionReport {
  readonly providerOrderId: string;
  /** Atlas id when the adapter can correlate it; null otherwise (reconcile later). */
  readonly atlasOrderId: string | null;
  readonly state: ExternalOrderState;
  readonly filledQty: number;
  readonly lastFillQty: number;
  readonly avgFillPrice: number | null;
  readonly providerStatus: string;
  readonly eventTs: number;
}

/** A working-order snapshot for reconciliation. */
export interface ExternalOrderSnapshot {
  readonly providerOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly qty: number;
  readonly filledQty: number;
  readonly state: ExternalOrderState;
}

/** A position snapshot for reconciliation. */
export interface ExternalPositionSnapshot {
  readonly symbol: string;
  readonly contractCode: string | null;
  readonly netQty: number;
  readonly avgPrice: number | null;
}

export interface ExternalExecutionCapabilities {
  readonly supportsMarketOrders: boolean;
  readonly supportsLimitOrders: boolean;
  readonly supportsStopOrders: boolean;
  readonly supportsModify: boolean;
  readonly supportsCancel: boolean;
  /** The venue can be asked for its current working orders / positions. */
  readonly supportsReconciliationSnapshot: boolean;
}

export type ExecutionReportListener = (report: ExecutionReport) => void;

/**
 * A real (or test) external venue transport. Atlas routes an EXTERNAL_* account's
 * intent here, records the linkage + lifecycle in its own store, and reconciles
 * the async reports back into its authoritative account state.
 */
export interface ExternalExecutionAdapter {
  readonly id: string;
  readonly kind: ExecutionProviderKind;

  configState(): ProviderConfigState;
  capabilities(): ExternalExecutionCapabilities;
  health(): ProviderHealthState;
  /** Redacted, secret-free snapshot for owner/ops surfaces. */
  healthSnapshot(): ProviderHealthSnapshot;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** Submit an order. Throws ExternalExecutionError; never a bare Error. */
  submit(input: ExternalSubmitInput): Promise<ExternalAck>;
  cancel(providerOrderId: string): Promise<void>;
  modify(providerOrderId: string, patch: { qty?: number; limitPrice?: number | null; stopPrice?: number | null }): Promise<void>;

  /** Reconciliation snapshots — the venue's own authoritative view. */
  listWorkingOrders(providerAccountId: string): Promise<ExternalOrderSnapshot[]>;
  listPositions(providerAccountId: string): Promise<ExternalPositionSnapshot[]>;

  /** Subscribe to async execution reports. Returns an unsubscribe fn. */
  onReport(listener: ExecutionReportListener): () => void;
}
