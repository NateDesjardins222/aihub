/**
 * Rithmic reconciliation (Milestone 9).
 *
 * Compares Atlas's recorded external state against Rithmic's authoritative
 * snapshots for ORDERS, EXECUTIONS and POSITIONS. Pure and deterministic: it takes
 * the two views and returns findings. It NEVER invents a correction when uncertain
 * — an ambiguous case is REQUIRES_REVIEW, not a silent repair. Safe, unambiguous
 * cases (a state Atlas simply hasn't caught up to) are marked auto-resolvable, and
 * any actual repair is performed + audited by the caller.
 */
import type { ExternalOrderSnapshot, ExternalPositionSnapshot } from '../../execution/external-provider.js';
import type { ExternalOrderState } from '@atlas/contracts';

export type ReconcileVerdict = 'MATCHED' | 'MISMATCH' | 'UNKNOWN' | 'REQUIRES_REVIEW';
export type ReconcileScope = 'ORDERS' | 'EXECUTIONS' | 'POSITIONS';

export interface OrderFinding {
  readonly scope: 'ORDERS';
  readonly verdict: ReconcileVerdict;
  readonly atlasOrderId: string | null;
  readonly providerOrderId: string | null;
  readonly detail: string;
  readonly autoResolvable: boolean;
  readonly providerState?: ExternalOrderState;
  readonly atlasState?: ExternalOrderState;
}

export interface PositionFinding {
  readonly scope: 'POSITIONS';
  readonly verdict: ReconcileVerdict;
  readonly symbol: string;
  readonly detail: string;
  readonly autoResolvable: boolean;
  readonly providerNetQty?: number;
  readonly atlasNetQty?: number;
}

export interface AtlasOrderView {
  readonly atlasOrderId: string;
  readonly providerOrderId: string | null;
  readonly state: ExternalOrderState;
  readonly filledQty: number;
}
export interface AtlasPositionView {
  readonly symbol: string;
  readonly netQty: number;
}

/** Order reconciliation: match by provider order id, then find gaps on either side. */
export function reconcileOrders(atlas: readonly AtlasOrderView[], provider: readonly ExternalOrderSnapshot[]): OrderFinding[] {
  const byProviderAtlas = new Map(atlas.filter((a) => a.providerOrderId).map((a) => [a.providerOrderId!, a]));
  const byProviderProv = new Map(provider.map((p) => [p.providerOrderId, p]));
  const findings: OrderFinding[] = [];

  for (const p of provider) {
    const a = byProviderAtlas.get(p.providerOrderId);
    if (!a) {
      // Provider has a working order Atlas doesn't know: never invent — review.
      findings.push({ scope: 'ORDERS', verdict: 'REQUIRES_REVIEW', atlasOrderId: null, providerOrderId: p.providerOrderId, detail: 'provider order missing in Atlas', autoResolvable: false, providerState: p.state });
      continue;
    }
    if (a.state === p.state && a.filledQty === p.filledQty) {
      findings.push({ scope: 'ORDERS', verdict: 'MATCHED', atlasOrderId: a.atlasOrderId, providerOrderId: p.providerOrderId, detail: 'ok', autoResolvable: false, atlasState: a.state, providerState: p.state });
    } else {
      // Atlas behind the provider's authoritative state is safe to adopt.
      const safe = isForwardTransition(a.state, p.state);
      findings.push({ scope: 'ORDERS', verdict: 'MISMATCH', atlasOrderId: a.atlasOrderId, providerOrderId: p.providerOrderId, detail: `state ${a.state}→${p.state}, filled ${a.filledQty}→${p.filledQty}`, autoResolvable: safe, atlasState: a.state, providerState: p.state });
    }
  }
  for (const a of atlas) {
    if (!a.providerOrderId) {
      // Atlas thinks it submitted but has no provider id: the lost-ack case → UNKNOWN.
      if (a.state === 'UNKNOWN' || a.state === 'PENDING_SUBMIT' || a.state === 'SUBMITTED') {
        findings.push({ scope: 'ORDERS', verdict: 'UNKNOWN', atlasOrderId: a.atlasOrderId, providerOrderId: null, detail: 'Atlas order has no provider id — reconcile before any resubmit', autoResolvable: false, atlasState: a.state });
      }
      continue;
    }
    if (!byProviderProv.has(a.providerOrderId) && isOpen(a.state)) {
      findings.push({ scope: 'ORDERS', verdict: 'MISMATCH', atlasOrderId: a.atlasOrderId, providerOrderId: a.providerOrderId, detail: 'Atlas shows open but provider has no such working order', autoResolvable: false, atlasState: a.state });
    }
  }
  return findings;
}

/** Position reconciliation by symbol; net-qty disagreements are reported, never auto-invented. */
export function reconcilePositions(atlas: readonly AtlasPositionView[], provider: readonly ExternalPositionSnapshot[]): PositionFinding[] {
  const byA = new Map(atlas.map((a) => [a.symbol, a]));
  const byP = new Map(provider.map((p) => [p.symbol, p]));
  const symbols = new Set([...byA.keys(), ...byP.keys()]);
  const findings: PositionFinding[] = [];
  for (const s of symbols) {
    const a = byA.get(s);
    const p = byP.get(s);
    const aq = a?.netQty ?? 0;
    const pq = p?.netQty ?? 0;
    if (aq === pq) {
      findings.push({ scope: 'POSITIONS', verdict: 'MATCHED', symbol: s, detail: 'ok', autoResolvable: false, atlasNetQty: aq, providerNetQty: pq });
    } else {
      findings.push({ scope: 'POSITIONS', verdict: 'MISMATCH', symbol: s, detail: `net qty Atlas ${aq} != provider ${pq}`, autoResolvable: false, atlasNetQty: aq, providerNetQty: pq });
    }
  }
  return findings;
}

export interface ReconcileSummary {
  matched: number;
  mismatch: number;
  unknown: number;
  requiresReview: number;
  autoResolvable: number;
}

export function summarize(findings: ReadonlyArray<OrderFinding | PositionFinding>): ReconcileSummary {
  const s: ReconcileSummary = { matched: 0, mismatch: 0, unknown: 0, requiresReview: 0, autoResolvable: 0 };
  for (const f of findings) {
    if (f.verdict === 'MATCHED') s.matched += 1;
    else if (f.verdict === 'MISMATCH') s.mismatch += 1;
    else if (f.verdict === 'UNKNOWN') s.unknown += 1;
    else s.requiresReview += 1;
    if (f.autoResolvable) s.autoResolvable += 1;
  }
  return s;
}

const ORDER_RANK: Record<ExternalOrderState, number> = {
  PENDING_SUBMIT: 0, SUBMITTED: 1, ACKNOWLEDGED: 2, PARTIALLY_FILLED: 3,
  PENDING_CANCEL: 3, FILLED: 4, CANCELED: 4, REJECTED: 4, UNKNOWN: -1,
};

/** A forward transition (Atlas simply behind the provider) is safe to adopt. */
function isForwardTransition(from: ExternalOrderState, to: ExternalOrderState): boolean {
  if (from === 'UNKNOWN') return true;
  return ORDER_RANK[to] >= ORDER_RANK[from];
}

function isOpen(state: ExternalOrderState): boolean {
  return state === 'SUBMITTED' || state === 'ACKNOWLEDGED' || state === 'PARTIALLY_FILLED' || state === 'PENDING_CANCEL';
}
