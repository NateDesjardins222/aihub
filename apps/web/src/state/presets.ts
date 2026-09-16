/**
 * Trading environment presets.
 *
 * A preset is a named bundle of THREE independent layers:
 *
 *   1. execution  - how the simulator fills. Server-side, authoritative.
 *   2. motion     - how the chart animates between observations. Client-side,
 *                   cosmetic, and deliberately unable to reach the engine.
 *   3. rules      - the programme's limits. Server-side, authoritative.
 *
 * Keeping them separate is the point. A preset that makes the chart prettier
 * cannot change what fills, and a preset that tightens a drawdown cannot change
 * how the chart looks. Adding a preset is adding an entry to this table; none
 * of it requires touching the execution engine.
 */
import type { ApiRuleConfig, SimulationEnvironment } from '../trading/api';
import { DEFAULT_MOTION, RAW_MOTION, type MotionSettings } from '../chart/motion';

export interface EnvironmentPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Sent to the server. Omitted keys keep the account's current value. */
  readonly execution?: Partial<SimulationEnvironment>;
  /** Kept in the browser. Never sent anywhere. */
  readonly motion?: Partial<MotionSettings>;
  /** Sent to the server as a per-account rule override. */
  readonly rules?: Partial<ApiRuleConfig>;
  /** Replay playback rate this preset prefers, when replay is running. */
  readonly replaySpeed?: number;
}

const DOLLARS = 1_000_000;

export const PRESETS: readonly EnvironmentPreset[] = [
  {
    id: 'REALISTIC',
    name: 'Realistic',
    description:
      'What a live account feels like: submission latency, a tick of slippage, and a limit that has to trade through before it fills.',
    execution: {
      fillModel: 'ADVANCED',
      latencyMs: 250,
      marketSlippageTicks: 1,
      stopSlippageTicks: 1,
      requireThroughTradeForLimit: true,
      useBarRange: true,
      intrabarPolicy: 'ADVERSE_FIRST',
      feesEnabled: true,
    },
    motion: DEFAULT_MOTION,
  },
  {
    id: 'SMOOTH',
    name: 'Smooth',
    description:
      'The same execution as Realistic, drawn with heavier animation. Easier to watch on a delayed feed; identical fills.',
    execution: {
      fillModel: 'ADVANCED',
      latencyMs: 250,
      marketSlippageTicks: 1,
      stopSlippageTicks: 1,
      requireThroughTradeForLimit: true,
      feesEnabled: true,
    },
    motion: { mode: 'SMOOTH', smoothing: 0.85, animationSpeed: 0.8, maxCatchUpMs: 2_000 },
  },
  {
    id: 'SCALPING',
    name: 'Scalping',
    description:
      'Fast hands: minimal latency, no slippage, and a limit that fills on a touch. Optimistic on purpose - use it to practise mechanics, not to measure an edge.',
    execution: {
      fillModel: 'ADVANCED',
      latencyMs: 30,
      marketSlippageTicks: 0,
      stopSlippageTicks: 0,
      requireThroughTradeForLimit: false,
      feesEnabled: true,
    },
    motion: { mode: 'RAW', smoothing: 0, animationSpeed: 1, maxCatchUpMs: 0 },
    replaySpeed: 2,
  },
  {
    id: 'PRACTICE',
    name: 'Practice',
    description:
      'Nothing in the way: instant fills, no fees, no rules to breach. For learning the platform rather than the market.',
    execution: {
      fillModel: 'SIMPLE',
      latencyMs: 0,
      marketSlippageTicks: 0,
      stopSlippageTicks: 0,
      requireThroughTradeForLimit: false,
      feesEnabled: false,
    },
    motion: DEFAULT_MOTION,
    rules: {
      profitTargetMicros: 0,
      maxLossMicros: 0,
      dailyLossLimitMicros: null,
      consistencyThreshold: null,
      minTradingDays: 0,
      minWinningDays: 0,
    },
  },
  {
    id: 'CHALLENGE',
    name: 'Challenge',
    description:
      'A typical evaluation on a 100K account: 3,000 target, 2,000 trailing drawdown that locks at the starting balance, 1,000 daily loss limit, three trading days.',
    execution: {
      fillModel: 'ADVANCED',
      latencyMs: 250,
      marketSlippageTicks: 1,
      stopSlippageTicks: 1,
      requireThroughTradeForLimit: true,
      feesEnabled: true,
    },
    motion: DEFAULT_MOTION,
    rules: {
      profitTargetMicros: 3_000 * DOLLARS,
      maxLossMicros: 2_000 * DOLLARS,
      drawdownType: 'INTRADAY_TRAILING',
      trailingLockAtMicros: 0,
      dailyLossLimitMicros: 1_000 * DOLLARS,
      dailyLossPolicy: 'LOCK_DAY',
      consistencyThreshold: 0.4,
      minTradingDays: 3,
      minWinningDays: 0,
      flattenOnBreach: true,
    },
  },
  {
    id: 'PROP_FIRM',
    name: 'Prop firm',
    description:
      'A funded account: end-of-day trailing drawdown, a hard daily limit that ends the account, and a consistency rule on payouts.',
    execution: {
      fillModel: 'ADVANCED',
      latencyMs: 350,
      marketSlippageTicks: 1,
      stopSlippageTicks: 2,
      requireThroughTradeForLimit: true,
      feesEnabled: true,
    },
    motion: DEFAULT_MOTION,
    rules: {
      profitTargetMicros: 0,
      maxLossMicros: 3_000 * DOLLARS,
      drawdownType: 'EOD_TRAILING',
      trailingLockAtMicros: 0,
      dailyLossLimitMicros: 1_500 * DOLLARS,
      dailyLossPolicy: 'FAIL',
      consistencyThreshold: 0.3,
      minTradingDays: 5,
      minWinningDays: 3,
      flattenOnBreach: true,
    },
  },
  {
    id: 'RAW_FEED',
    name: 'Raw feed',
    description:
      'No animation of any kind: every observation is drawn the instant it arrives, exactly as the vendor sent it.',
    motion: RAW_MOTION,
  },
];

export function presetById(id: string): EnvironmentPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Does this preset describe the state the account is actually in?
 *
 * Only the keys a preset SETS are compared: a preset that says nothing about
 * fees is not contradicted by whatever the account's fee setting happens to be.
 */
export function presetMatches(
  preset: EnvironmentPreset,
  execution: SimulationEnvironment | null,
  motion: MotionSettings,
): boolean {
  if (preset.execution) {
    if (!execution) return false;
    for (const [key, value] of Object.entries(preset.execution)) {
      if ((execution as unknown as Record<string, unknown>)[key] !== value) return false;
    }
  }
  if (preset.motion) {
    for (const [key, value] of Object.entries(preset.motion)) {
      if ((motion as unknown as Record<string, unknown>)[key] !== value) return false;
    }
  }
  return true;
}
