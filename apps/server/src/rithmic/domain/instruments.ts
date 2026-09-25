/**
 * Rithmic instrument mapping + reference-data reconciliation (Milestone 9).
 *
 * Atlas's instrument registry (@atlas/instruments) stays canonical for tick size,
 * point value and risk economics. Rithmic reference data is validated AGAINST it
 * and discrepancies are surfaced — never silently trusted, never silently
 * ignored. The active/front contract is NOT guessed here: a candidate is derived
 * for a subscription request, but the authoritative Rithmic trading symbol comes
 * from reference discovery at runtime (§11).
 */
import { getInstrument } from '@atlas/instruments';

/** The eight launch instruments. */
export const LAUNCH_ROOTS = ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL'] as const;
export type LaunchRoot = (typeof LAUNCH_ROOTS)[number];

export function isLaunchRoot(root: string): root is LaunchRoot {
  return (LAUNCH_ROOTS as readonly string[]).includes(root);
}

export interface AtlasInstrumentCanonical {
  readonly root: string;
  readonly exchange: string;
  readonly tickSize: number;
  readonly pointValue: number;
  readonly tickValue: number;
}

/** Canonical Atlas economics for a root, in real (unscaled) units. */
export function atlasCanonical(root: string): AtlasInstrumentCanonical {
  const spec = getInstrument(root);
  if (!spec) throw new Error(`unknown Atlas instrument ${root}`);
  const scale = 10 ** spec.pricePrecision;
  return {
    root: spec.root,
    exchange: spec.exchange,
    tickSize: spec.tickSizeScaled / scale,
    pointValue: spec.pointValueMicros / 1_000_000,
    tickValue: spec.tickValueMicros / 1_000_000,
  };
}

/** The Rithmic exchange code for a root (from the canonical registry, not guessed). */
export function rithmicExchange(root: string): string {
  return atlasCanonical(root).exchange;
}

/** Reference data as normalized from Rithmic's ResponseReferenceData. */
export interface RithmicReferenceData {
  readonly symbol: string;
  readonly exchange: string;
  readonly tickSize: number | null;
  readonly pointValue: number | null;
  readonly expiration: string | null;
  readonly tradingSymbol: string | null;
  readonly tradable: boolean | null;
}

export type ReconcileStatus = 'MATCHED' | 'DISCREPANCY' | 'INCOMPLETE';

export interface InstrumentReconciliation {
  readonly root: string;
  readonly status: ReconcileStatus;
  readonly discrepancies: readonly string[];
  readonly canonical: AtlasInstrumentCanonical;
  readonly provider: RithmicReferenceData;
}

/**
 * Reconcile Rithmic reference data against Atlas canonical economics. Atlas stays
 * authoritative; a mismatch is reported (never used to overwrite Atlas), and an
 * exchange mismatch or an untradable/synthetic instrument is flagged rather than
 * silently stitched.
 */
export function reconcileReferenceData(root: string, provider: RithmicReferenceData): InstrumentReconciliation {
  const canonical = atlasCanonical(root);
  const discrepancies: string[] = [];
  let incomplete = false;

  if (provider.exchange && provider.exchange.toUpperCase() !== canonical.exchange.toUpperCase()) {
    discrepancies.push(`exchange ${provider.exchange} != canonical ${canonical.exchange}`);
  }
  if (provider.tickSize == null) incomplete = true;
  else if (!approxEqual(provider.tickSize, canonical.tickSize)) {
    discrepancies.push(`tickSize ${provider.tickSize} != canonical ${canonical.tickSize}`);
  }
  if (provider.pointValue == null) incomplete = true;
  else if (!approxEqual(provider.pointValue, canonical.pointValue)) {
    discrepancies.push(`pointValue ${provider.pointValue} != canonical ${canonical.pointValue}`);
  }
  if (provider.tradable === false) discrepancies.push('provider reports instrument not tradable');

  const status: ReconcileStatus =
    discrepancies.length > 0 ? 'DISCREPANCY' : incomplete ? 'INCOMPLETE' : 'MATCHED';
  return { root, status, discrepancies, canonical, provider };
}

function approxEqual(a: number, b: number, epsilonRatio = 1e-6): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * epsilonRatio;
}

/** Parse a raw ResponseReferenceData message into normalized reference data. */
export function parseReferenceData(msg: Record<string, unknown>): RithmicReferenceData {
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== null && v !== '' ? n : null;
  };
  const bool = (v: unknown): boolean | null => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  };
  return {
    symbol: String(msg['symbol'] ?? ''),
    exchange: String(msg['exchange'] ?? ''),
    tickSize: num(msg['min_qprice_change']),
    pointValue: num(msg['single_point_value']),
    expiration: msg['expiration_date'] != null ? String(msg['expiration_date']) : null,
    tradingSymbol: msg['trading_symbol'] != null ? String(msg['trading_symbol']) : null,
    tradable: bool(msg['is_tradable']),
  };
}
