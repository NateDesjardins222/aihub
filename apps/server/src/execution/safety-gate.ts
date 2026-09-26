/**
 * External execution safety gate (M4-Q).
 *
 * Before any order could leave Atlas for an EXTERNAL venue, this validates the
 * production-infrastructure preconditions the account-level risk engine does not
 * cover. It is ADDITIONAL defense — the existing Atlas risk engine stays
 * authoritative for account state, sizing, limits and market/staleness gates;
 * this gate adds mode + mapping + provider connection + contract + session +
 * freshness checks specific to routing an order off-platform.
 *
 * The browser can only express intent. Provider name, execution mode, provider
 * account id, entitlement and contract mapping are NEVER trusted from the client:
 * this gate reads them server-side from the durable mapping.
 *
 * SIMULATION always passes here (there is nothing external to guard); the gate's
 * job begins at EXTERNAL_*. In this milestone no account is mapped externally, so
 * a SIMULATION account never even reaches the external checks — but the checks
 * exist and are tested so external routing is safe the day it is enabled.
 */
import type { ExecutionMode, ProviderAccountMapping, RejectReason } from '@atlas/contracts';
import type { ExecutionRegistry } from './registry.js';
import { SymbologyError, symbology } from '../infra/symbology.js';
import { sessionAuthority } from '../infra/session-authority.js';

export interface FreshnessLike {
  readonly state: 'FRESH' | 'STALE' | 'MARKET_CLOSED' | 'NO_DATA' | string;
  readonly blocksOrderEntry: boolean;
}

export interface SafetyGateInput {
  readonly mapping: ProviderAccountMapping;
  readonly registry: ExecutionRegistry;
  readonly root: string;
  readonly contractCode: string | null;
  /** Exchange clock (latest observation time) for session + contract checks. */
  readonly marketNow: number;
  /** Freshness for the instrument, as computed by the market-data service. */
  readonly freshness: FreshnessLike | null;
  /**
   * Owner kill switch `DISABLE_EXTERNAL_EXECUTION`, resolved server-side by the
   * caller (external execution is DISCONNECTED today, so no production caller yet;
   * the gate already enforces it so external routing is safe the day it is wired).
   */
  readonly killSwitchEngaged?: boolean;
  /** Provider connection is CONNECTED for the mapped provider (execution). */
}

export type SafetyGateResult =
  | { readonly allow: true; readonly mode: ExecutionMode }
  | { readonly allow: false; readonly reason: RejectReason; readonly message: string };

/**
 * Evaluate the external-execution safety gate. Returns allow (with the resolved
 * mode) or a structured, specific rejection — never a generic "order failed".
 */
export function externalExecutionGate(input: SafetyGateInput): SafetyGateResult {
  const { mapping } = input;

  // SIMULATION: nothing external to guard here. The engine + risk are authority.
  if (mapping.executionMode === 'SIMULATION') {
    return { allow: true, mode: 'SIMULATION' };
  }

  // Kill switch (HTF-10 enforcement): an owner can halt all external routing.
  // SIMULATION already returned above, so this only ever blocks EXTERNAL_*.
  if (input.killSwitchEngaged) {
    return { allow: false, reason: 'EXECUTION_PROVIDER_UNAVAILABLE', message: 'External execution is disabled by an operator kill switch.' };
  }

  // A suspended mapping never routes externally.
  if (mapping.status !== 'ACTIVE') {
    return { allow: false, reason: 'EXECUTION_PROVIDER_UNAVAILABLE', message: 'Account provider mapping is suspended.' };
  }

  // Contract / instrument validation (root/expiry/cross-root guard).
  try {
    symbology.assertExecutable(input.root, input.contractCode, input.marketNow);
  } catch (err) {
    if (err instanceof SymbologyError) {
      if (err.code === 'CONTRACT_EXPIRED') return { allow: false, reason: 'CONTRACT_EXPIRED', message: err.message };
      if (err.code === 'UNKNOWN_INSTRUMENT') return { allow: false, reason: 'UNKNOWN_INSTRUMENT', message: err.message };
      return { allow: false, reason: 'INSTRUMENT_NOT_PERMITTED', message: err.message };
    }
    return { allow: false, reason: 'INTERNAL_ERROR', message: 'Contract validation failed.' };
  }

  // Session authority: only OPEN may route an external order.
  const session = sessionAuthority.status(input.root, input.marketNow);
  if (session.state !== 'OPEN') {
    return { allow: false, reason: 'MARKET_CLOSED', message: `Market ${input.root} is ${session.state} (${session.reason}).` };
  }

  // Market freshness: never route an external order into a stale/absent feed.
  if (!input.freshness || input.freshness.state === 'NO_DATA') {
    return { allow: false, reason: 'MARKET_DATA_UNAVAILABLE', message: 'No market data for the instrument.' };
  }
  if (input.freshness.state === 'STALE' || input.freshness.blocksOrderEntry) {
    return { allow: false, reason: 'MARKET_DATA_STALE', message: 'Market data is stale.' };
  }

  // Provider availability (configured + connected + live-gate for EXTERNAL_LIVE).
  const readiness = input.registry.externalReadiness(mapping.executionMode, mapping.executionProvider);
  if (!readiness.ready) {
    return { allow: false, reason: 'EXECUTION_PROVIDER_UNAVAILABLE', message: readiness.reason };
  }

  return { allow: true, mode: mapping.executionMode };
}
