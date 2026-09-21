/**
 * The execution provider seam.
 *
 * Market data and execution are different concerns, and Atlas already keeps a
 * provider-neutral seam for market data. It has none for execution: the trading
 * engine *is* the venue. That is correct today - every account is simulated -
 * but it means "add Rithmic/CQG execution later" reads as "rewrite the call
 * sites". This interface is the seam that prevents that.
 *
 * It is deliberately capability-based. A future live provider need not support
 * everything the simulator does (bracket attachment, synthetic reverse); a
 * caller asks `capabilities()` rather than assuming. No live provider is
 * implemented here, and none is faked - only the simulator, wrapped as a
 * first-class provider so the shape is proven against real behaviour.
 *
 * Simulation stays first-class: professional market data feeding
 * `AtlasSimulationExecutionProvider` is an explicitly supported architecture,
 * because an evaluation account is simulated even when the prices are real.
 */
import type {
  AccountValuation,
  EngineChange,
  SubmitOrderInput,
  TradingEngine,
} from '../trading/engine.js';

export interface ExecutionCapabilities {
  /** The provider clears and fills against Atlas's own simulator, not a venue. */
  readonly isSimulation: boolean;
  readonly supportsMarketOrders: boolean;
  readonly supportsLimitOrders: boolean;
  readonly supportsStopOrders: boolean;
  readonly supportsTrailingStops: boolean;
  /** Server-attached OCO brackets on the entry order. */
  readonly supportsBrackets: boolean;
  readonly supportsModify: boolean;
  readonly supportsFlatten: boolean;
  /** One request that closes and re-opens the opposite side. */
  readonly supportsReverse: boolean;
}

export type ExecutionHealth = 'HEALTHY' | 'DEGRADED' | 'OFFLINE';

export interface ExecutionProviderStatus {
  readonly providerId: string;
  readonly health: ExecutionHealth;
  readonly isSimulation: boolean;
  readonly detail: string;
}

/**
 * A venue Atlas can route orders to. Every method is account-scoped and returns
 * the authoritative post-change view, exactly as the engine does today, so the
 * simulator satisfies it without translation and a real provider adapter has a
 * definite contract to meet.
 */
export interface ExecutionProvider {
  readonly id: string;
  capabilities(): ExecutionCapabilities;
  status(): ExecutionProviderStatus;

  submitOrder(input: SubmitOrderInput): Promise<EngineChange>;
  cancelOrder(accountId: string, orderId: string): Promise<EngineChange>;
  cancelAll(accountId: string, symbol?: string): Promise<EngineChange>;
  modifyOrder(
    accountId: string,
    orderId: string,
    patch: {
      qty?: number;
      limitTicks?: number | null;
      stopTicks?: number | null;
      trailTicks?: number | null;
    },
    expectedVersion?: number,
  ): Promise<EngineChange>;
  flatten(accountId: string, userId: string, symbol: string): Promise<EngineChange>;
  reverse(accountId: string, userId: string, symbol: string): Promise<EngineChange>;

  /** The authoritative account view - position, orders, valuation. */
  getAccountState(accountId: string): Promise<AccountValuation | null>;
}

/**
 * The Atlas simulator as an execution provider.
 *
 * A thin, faithful delegation to the existing engine - it adds no behaviour,
 * it only proves the engine's operations map onto the provider-neutral contract
 * one-for-one. Because it holds a `TradingEngine`, it inherits the engine's
 * cross-process account lock and transactional guarantees unchanged.
 */
export class AtlasSimulationExecutionProvider implements ExecutionProvider {
  readonly id = 'atlas-sim';

  constructor(private readonly engine: TradingEngine) {}

  capabilities(): ExecutionCapabilities {
    return {
      isSimulation: true,
      supportsMarketOrders: true,
      supportsLimitOrders: true,
      supportsStopOrders: true,
      supportsTrailingStops: true,
      supportsBrackets: true,
      supportsModify: true,
      supportsFlatten: true,
      supportsReverse: true,
    };
  }

  status(): ExecutionProviderStatus {
    return {
      providerId: this.id,
      health: 'HEALTHY',
      isSimulation: true,
      detail: 'Atlas in-process simulation engine.',
    };
  }

  submitOrder(input: SubmitOrderInput): Promise<EngineChange> {
    return this.engine.submitOrder(input);
  }

  cancelOrder(accountId: string, orderId: string): Promise<EngineChange> {
    return this.engine.cancelOrder(accountId, orderId);
  }

  cancelAll(accountId: string, symbol?: string): Promise<EngineChange> {
    return this.engine.cancelAll(accountId, symbol);
  }

  modifyOrder(
    accountId: string,
    orderId: string,
    patch: { qty?: number; limitTicks?: number | null; stopTicks?: number | null; trailTicks?: number | null },
    expectedVersion?: number,
  ): Promise<EngineChange> {
    return this.engine.modifyOrder(accountId, orderId, patch, expectedVersion);
  }

  flatten(accountId: string, userId: string, symbol: string): Promise<EngineChange> {
    return this.engine.flatten(accountId, userId, symbol);
  }

  reverse(accountId: string, userId: string, symbol: string): Promise<EngineChange> {
    return this.engine.reverse(accountId, userId, symbol);
  }

  getAccountState(accountId: string): Promise<AccountValuation | null> {
    return this.engine.valuation(accountId);
  }
}
