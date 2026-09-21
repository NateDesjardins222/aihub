/**
 * Contract identity — the difference between a root, a contract, and a series.
 *
 * Atlas has treated "NQ" as if it were one thing. It is three:
 *   - a RootInstrument: the product line NQ, its economics and venue;
 *   - a TradableContract: NQZ26, a specific listed contract that expires;
 *   - a ContinuousSeries: "NQ front month", a stitched series a chart draws but
 *     no one can trade.
 * A ProviderInstrument is how a given data/execution vendor names one of these.
 *
 * The chart may draw a continuous series; an order must always resolve to a
 * tradable contract. This module is the boundary that turns a root plus an
 * instant into the contract that was actually live then — deterministically,
 * from the exchange listing cycle and roll rule, with no vendor call and no
 * invented roll behaviour we do not have.
 */
import type { InstrumentSpec } from '@atlas/contracts';
import { requireInstrument } from './registry.js';
import { resolveActiveContract, isExpired, type ActiveContract } from './contracts.js';

/** The product line. The economics that every contract of this root shares. */
export interface RootInstrument {
  readonly root: string;
  readonly displayName: string;
  readonly exchange: string;
  readonly assetClass: string;
  readonly currency: string;
  readonly pricePrecision: number;
  readonly tickSizeScaled: number;
  readonly pointValueMicros: number;
  readonly tickValueMicros: number;
  readonly contractMultiplier: number;
  readonly isMicro: boolean;
}

/** A specific, expiring, tradable contract: NQZ26. */
export interface TradableContract extends RootInstrument {
  /** e.g. "NQZ26". The identity that must survive persistence. */
  readonly code: string;
  readonly contractMonth: number; // 1-12
  readonly contractYear: number;
  /** Last trading day, epoch ms at exchange-local midnight. */
  readonly lastTradingDay: number;
  /** When the front month rolls off this contract, epoch ms. */
  readonly rollDate: number;
  /** True when the instant asked about is past this contract's last trading day. */
  readonly expired: boolean;
  /** Vendor symbol mappings carried through from the spec; may be empty. */
  readonly providerSymbols: Readonly<Record<string, string>>;
}

/** A continuous, stitched series a chart draws. Never an order's identity. */
export interface ContinuousSeries {
  readonly root: string;
  /** A stable id for the series, e.g. "NQ.c.0" (front-month continuous). */
  readonly seriesId: string;
  readonly description: string;
  /** 0 = front month. Deeper series (1 = second month) are future work. */
  readonly depth: number;
}

/** How one vendor names an instrument. */
export interface ProviderInstrument {
  readonly provider: string;
  readonly providerSymbol: string;
  readonly root: string;
  /** The specific contract this mapping is for, when the vendor is contract-specific. */
  readonly contractCode: string | null;
}

function rootOf(spec: InstrumentSpec): RootInstrument {
  return {
    root: spec.root,
    displayName: spec.displayName,
    exchange: spec.exchange,
    assetClass: spec.assetClass,
    currency: spec.currency,
    pricePrecision: spec.pricePrecision,
    tickSizeScaled: spec.tickSizeScaled,
    pointValueMicros: spec.pointValueMicros,
    tickValueMicros: spec.tickValueMicros,
    contractMultiplier: spec.contractMultiplier,
    isMicro: spec.isMicro,
  };
}

/**
 * Turns a root and an instant into concrete identities. Stateless and
 * deterministic: given the same root and timestamp it always resolves the same
 * contract, so a fill's contract code is reproducible and testable.
 */
export class ContractResolver {
  /** The economics of a root, with no contract attached. */
  resolveRoot(root: string): RootInstrument {
    return rootOf(requireInstrument(root));
  }

  /** The tradable contract that was the front month at `timestamp`. */
  resolveTradableContract(input: { root: string; timestamp: number }): TradableContract {
    const spec = requireInstrument(input.root);
    const active: ActiveContract = resolveActiveContract(spec, input.timestamp);
    return {
      ...rootOf(spec),
      code: active.code,
      contractMonth: active.month,
      contractYear: active.year,
      lastTradingDay: active.lastTradingDay,
      rollDate: active.rollDate,
      expired: isExpired(active, input.timestamp),
      providerSymbols: spec.providerSymbols ?? {},
    };
  }

  /**
   * Just the contract code, or null when the root is unknown or unresolvable.
   * The persistence path uses this: a null code means "root only", never a wrong
   * code.
   */
  contractCode(root: string, timestamp: number): string | null {
    try {
      return this.resolveTradableContract({ root, timestamp }).code;
    } catch {
      return null;
    }
  }

  /** The front-month continuous series for a root — what a chart draws. */
  resolveContinuousSeries(root: string, depth = 0): ContinuousSeries {
    const spec = requireInstrument(root);
    return {
      root: spec.root,
      seriesId: `${spec.root}.c.${depth}`,
      description: `${spec.displayName} continuous${depth === 0 ? ' (front month)' : ` (+${depth})`}`,
      depth,
    };
  }

  /** How a vendor names this root's front-month contract at `timestamp`. */
  providerInstrument(provider: string, root: string, timestamp?: number): ProviderInstrument {
    const spec = requireInstrument(root);
    const providerSymbol = spec.providerSymbols?.[provider] ?? spec.root;
    return {
      provider,
      providerSymbol,
      root: spec.root,
      contractCode: timestamp === undefined ? null : this.contractCode(root, timestamp),
    };
  }
}

/** A shared, stateless resolver. It holds no connection and no clock. */
export const contractResolver = new ContractResolver();
