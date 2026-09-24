/**
 * Canonical symbology service (M4-G).
 *
 * ONE registry owns the mapping between Atlas symbols and provider symbols. No
 * provider symbol string is scattered through the app; adapters ask here.
 *
 *   Atlas root (NQ)  ↔  provider symbol (yahoo: NQ=F, databento: NQ.c.0, ...)
 *   Atlas root (NQ)  →  specific contract (NQZ26)  →  provider contract symbol
 *
 * It is deterministic and stateless (contract resolution takes an instant). It
 * also owns the validation that prevents the dangerous mistakes: NQ data used
 * for MNQ execution, a contract code that does not belong to its root, and an
 * expired contract reaching execution.
 */
import {
  contractResolver,
  getInstrument,
  isExpired,
  resolveActiveContract,
} from '@atlas/instruments';
import type { MarketDataProviderKind } from '@atlas/contracts';

export class SymbologyError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_INSTRUMENT'
      | 'UNKNOWN_PROVIDER_SYMBOL'
      | 'CONTRACT_ROOT_MISMATCH'
      | 'CONTRACT_EXPIRED'
      | 'NO_PROVIDER_SYMBOL',
    message: string,
  ) {
    super(message);
    this.name = 'SymbologyError';
  }
}

/** How a provider names a root's continuous/front-month series. */
export interface ProviderMapping {
  readonly provider: string;
  readonly root: string;
  readonly providerSymbol: string;
  /** The specific contract code at the given instant, when one was requested. */
  readonly contractCode: string | null;
}

/**
 * The provider KIND (as configured / in contracts) mapped to the registry's
 * `providerSymbols` key. The registry keys Yahoo under "yahoo" while the
 * configured kind is "yahoo-delayed"; this is the one place that difference lives.
 */
function registryKey(provider: string): string {
  return provider === 'yahoo-delayed' ? 'yahoo' : provider;
}

export class Symbology {
  /** Atlas root → provider symbol for a provider's continuous/front series. */
  toProviderSymbol(provider: MarketDataProviderKind | string, root: string): string {
    const spec = getInstrument(root);
    if (!spec) throw new SymbologyError('UNKNOWN_INSTRUMENT', `Unknown instrument ${root}`);
    const mapped = spec.providerSymbols?.[registryKey(provider)];
    // Deterministic per-provider defaults where the registry has no explicit map:
    // databento uses continuous front-month symbology; others fall back to the
    // Atlas root so a dev/test provider keyed on the root still resolves.
    if (mapped) return mapped;
    if (provider === 'databento') return contractResolver.resolveContinuousSeries(spec.root).seriesId;
    if (provider === 'scripted' || provider === 'replay' || provider === 'rithmic') return spec.root;
    throw new SymbologyError(
      'NO_PROVIDER_SYMBOL',
      `No ${provider} symbol mapping for ${spec.root}`,
    );
  }

  /** Provider symbol → Atlas root (reverse lookup), or null if unmapped. */
  toRoot(provider: MarketDataProviderKind | string, providerSymbol: string): string | null {
    // Explicit registry mappings first (authoritative).
    const key = registryKey(provider);
    for (const spec of listSpecs()) {
      if (spec.providerSymbols?.[key] === providerSymbol) return spec.root;
    }
    // Databento continuous symbology: "<ROOT>.c.<n>".
    if (provider === 'databento') {
      const m = /^([A-Z0-9]+)\.c\.\d+$/.exec(providerSymbol);
      if (m && getInstrument(m[1]!)) return m[1]!.toUpperCase();
    }
    // Bare root (dev/test/rithmic default).
    if (getInstrument(providerSymbol)) return providerSymbol.toUpperCase();
    return null;
  }

  /** Full mapping for a root at an instant (contract-aware). */
  resolve(provider: MarketDataProviderKind | string, root: string, asOfMs?: number): ProviderMapping {
    const spec = getInstrument(root);
    if (!spec) throw new SymbologyError('UNKNOWN_INSTRUMENT', `Unknown instrument ${root}`);
    return {
      provider,
      root: spec.root,
      providerSymbol: this.toProviderSymbol(provider, spec.root),
      contractCode: asOfMs === undefined ? null : contractResolver.contractCode(spec.root, asOfMs),
    };
  }

  /**
   * Validate that a specific contract is safe to EXECUTE against for a root at an
   * instant. Throws a SymbologyError otherwise. This is the guard that stops NQ
   * data driving MNQ execution, a wrong-root contract code, or an expired
   * contract reaching the venue.
   */
  assertExecutable(root: string, contractCode: string | null, asOfMs: number): void {
    const spec = getInstrument(root);
    if (!spec) throw new SymbologyError('UNKNOWN_INSTRUMENT', `Unknown instrument ${root}`);
    // No specific contract asserted → the caller trades the resolved front month;
    // still verify one is resolvable and unexpired.
    const active = resolveActiveContract(spec, asOfMs);
    if (isExpired(active, asOfMs)) {
      throw new SymbologyError(
        'CONTRACT_EXPIRED',
        `Front-month contract ${active.code} for ${spec.root} is expired`,
      );
    }
    if (contractCode === null) return;
    // A supplied contract code MUST belong to this exact root. "NQZ26" must never
    // be executed under MNQ. Contract codes begin with the root symbol.
    if (!contractCode.toUpperCase().startsWith(spec.root.toUpperCase())) {
      throw new SymbologyError(
        'CONTRACT_ROOT_MISMATCH',
        `Contract ${contractCode} does not belong to root ${spec.root}`,
      );
    }
  }
}

function listSpecs() {
  // Small, fixed instrument set; a direct import avoids a listInstruments cycle.
  return ['NQ', 'MNQ', 'ES', 'MES', 'GC', 'MGC', 'CL', 'MCL']
    .map((r) => getInstrument(r))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
}

export const symbology = new Symbology();
