/**
 * Simulation environment settings.
 *
 * These are the knobs that decide how pessimistic the simulator is. They are
 * data, held per account, so a trader can be evaluated under one set of
 * assumptions and a strategy researched under another without a code change.
 *
 * The defaults are deliberately conservative. A simulator that flatters the
 * trader is worse than useless: it teaches habits that lose money live.
 */

export type FillModel =
  /** Fill at the far touch, no latency, no slippage. Optimistic; for teaching. */
  | 'SIMPLE'
  /** Far touch plus configurable latency and slippage. The default. */
  | 'ADVANCED'
  /** Consumes real book levels. Requires a licensed depth feed; not available. */
  | 'DEPTH_AWARE';

/**
 * How to resolve the order of events inside a single bar.
 *
 * A one-minute bar tells us the high and the low but not which came first. When
 * a position's stop and target both sit inside that range, the outcome is
 * genuinely unknown.
 */
export type IntrabarPolicy =
  /** Assume the adverse side traded first. Never resolves ambiguity in the trader's favour. */
  | 'ADVERSE_FIRST'
  /** Only fill from prices actually observed on the quote stream; ignore bar extremes. */
  | 'OBSERVED_ONLY';

export interface SimulationEnvironment {
  readonly fillModel: FillModel;

  /**
   * Use a closed bar's high and low to fill resting orders.
   *
   * On a delayed feed the quote stream samples every few seconds and misses
   * most of what traded. Ignoring the bar's real extremes would mean a stop the
   * market genuinely ran through never fills, which flatters the trader badly.
   */
  readonly useBarRange: boolean;
  readonly intrabarPolicy: IntrabarPolicy;

  /** Delay between acceptance and eligibility to fill, in milliseconds. */
  readonly latencyMs: number;
  /** Adverse slippage applied to market orders, in ticks. */
  readonly marketSlippageTicks: number;
  /** Additional adverse slippage applied when a stop is triggered. */
  readonly stopSlippageTicks: number;

  /**
   * Maximum contracts a single market event can fill. Null fills in full.
   *
   * This is a crude stand-in for finite liquidity. Real size-dependent fills
   * need depth data, which this feed does not carry.
   */
  readonly maxContractsPerFill: number | null;

  /**
   * Require the market to trade THROUGH a resting limit rather than merely
   * touch it. Touching a price does not guarantee a queue position at it.
   */
  readonly requireThroughTradeForLimit: boolean;

  /** Charge commission and exchange fees. */
  readonly feesEnabled: boolean;
  /** Override the registry's per-side commission, in micro-dollars. Null uses the registry. */
  readonly commissionPerSideMicrosOverride: number | null;
}

export const DEFAULT_ENVIRONMENT: SimulationEnvironment = {
  fillModel: 'ADVANCED',
  useBarRange: true,
  intrabarPolicy: 'ADVERSE_FIRST',
  latencyMs: 250,
  marketSlippageTicks: 1,
  stopSlippageTicks: 1,
  maxContractsPerFill: null,
  requireThroughTradeForLimit: true,
  feesEnabled: true,
  commissionPerSideMicrosOverride: null,
};

/** Frictionless settings, for isolating engine behaviour in tests. */
export const FRICTIONLESS_ENVIRONMENT: SimulationEnvironment = {
  ...DEFAULT_ENVIRONMENT,
  fillModel: 'SIMPLE',
  latencyMs: 0,
  marketSlippageTicks: 0,
  stopSlippageTicks: 0,
  requireThroughTradeForLimit: false,
  feesEnabled: false,
};

export function normalizeEnvironment(
  patch: Partial<SimulationEnvironment> | null | undefined,
): SimulationEnvironment {
  const merged = { ...DEFAULT_ENVIRONMENT, ...(patch ?? {}) };
  return {
    ...merged,
    latencyMs: clamp(merged.latencyMs, 0, 60_000),
    marketSlippageTicks: clamp(merged.marketSlippageTicks, 0, 100),
    stopSlippageTicks: clamp(merged.stopSlippageTicks, 0, 100),
    maxContractsPerFill:
      merged.maxContractsPerFill === null ? null : Math.max(1, Math.floor(merged.maxContractsPerFill)),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Depth-aware filling needs a licensed feed; say so rather than pretending. */
export function fillModelAvailable(model: FillModel, depthLevels: number): boolean {
  return model !== 'DEPTH_AWARE' || depthLevels > 1;
}
