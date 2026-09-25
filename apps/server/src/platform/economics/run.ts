/**
 * Compose a complete, auditable economics run: the headline simulation plus its
 * sensitivity sweeps, Monte-Carlo distributions and break-even analysis, with the
 * exact inputs snapshotted so the run is reproducible forever.
 *
 * Pure and deterministic. No production side effects.
 */
import {
  AUTHORITATIVE, ENGINE_VERSION, MODEL_VERSION, loadAuthoritativeProducts,
  type Assumptions, type AuthoritativeProduct,
} from './config.js';
import { simulate, type SimResult } from './engine.js';
import { breakEvenKey, monteCarlo, sensitivityAll, type BreakEven, type Lever, type MonteCarloResult, type SensitivityPoint } from './analysis.js';
import { scenario, type ScenarioName } from './scenarios.js';

export interface RunParams {
  scenario?: ScenarioName;
  /** Explicit assumptions override the scenario when provided. */
  assumptions?: Assumptions;
  seed: number;
  customers: number;
  horizonDays: number;
  trials: number;
}

export interface EconRunBundle {
  engineVersion: string;
  modelVersion: string;
  generatedAt: string;
  scenario: ScenarioName | 'CUSTOM';
  seed: number;
  customers: number;
  horizonDays: number;
  trials: number;
  authoritative: typeof AUTHORITATIVE;
  products: AuthoritativeProduct[];
  assumptions: Assumptions;
  result: SimResult;
  sensitivity: Record<Lever, SensitivityPoint[]>;
  monteCarlo: MonteCarloResult;
  breakEven: BreakEven[];
}

export function runEconomics(params: RunParams): EconRunBundle {
  const products = loadAuthoritativeProducts();
  const scenarioName: ScenarioName | 'CUSTOM' = params.assumptions ? 'CUSTOM' : (params.scenario ?? 'BASE');
  const assumptions = params.assumptions ?? scenario(params.scenario ?? 'BASE');
  const input = { products, assumptions, seed: params.seed, customers: params.customers, horizonDays: params.horizonDays };

  const result = simulate(input);
  const sensitivity = sensitivityAll(input);
  const mc = monteCarlo(input, params.trials, assumptions.safetyReserveMultiplier);
  const be = breakEvenKey(input);

  // Fold the Monte-Carlo safety reserve suggestion into the treasury view so the
  // reserve total reflects the modelled tail.
  result.treasury.safetyReserveMicros = mc.suggestedSafetyReserveMicros;
  result.treasury.requiredReserveMicros += mc.suggestedSafetyReserveMicros;
  result.treasury.distributableCashMicros = result.treasury.cashCollectedMicros - result.treasury.requiredReserveMicros;

  return {
    engineVersion: ENGINE_VERSION, modelVersion: MODEL_VERSION, generatedAt: new Date().toISOString(),
    scenario: scenarioName, seed: params.seed, customers: params.customers, horizonDays: params.horizonDays,
    trials: params.trials, authoritative: AUTHORITATIVE, products, assumptions,
    result, sensitivity, monteCarlo: mc, breakEven: be,
  };
}
