/**
 * Merge a live valuation frame into the account P&L replica.
 *
 * The rule this enforces (D-13): a figure the frame carries is applied even
 * when it is `null`, because `null` is the authoritative "cannot be priced".
 * The old merge coalesced null away with `??` and kept the last good number —
 * a phantom P&L the account no longer has, with the NOT-PRICED badge suppressed
 * because `marked` never refreshed. A field the frame OMITS (`undefined`) keeps
 * its prior value. Unknown stays unknown; a number appears only when it is
 * authoritative. Pure, so it is unit-testable in isolation.
 */
import type { ApiAccountPnl } from './api';

export interface ValuationFrame {
  readonly balanceMicros?: number;
  readonly equityMicros?: number | null;
  readonly openPnlMicros?: number | null;
  readonly dayPnlMicros?: number | null;
  readonly remainingDrawdownMicros?: number | null;
  readonly openContracts?: number;
  readonly rules?: { readonly marked?: boolean } | undefined;
  readonly unmarkable?: ApiAccountPnl['unmarkable'];
}

/** Apply `next` if the frame carried it (including null); else keep `prev`. */
function applied<T>(next: T | undefined, prev: T): T {
  return next === undefined ? prev : next;
}

export function mergePnlFrame(prev: ApiAccountPnl, frame: ValuationFrame): ApiAccountPnl {
  return {
    ...prev,
    balanceMicros: frame.balanceMicros ?? prev.balanceMicros,
    equityMicros: applied(frame.equityMicros, prev.equityMicros),
    openPnlMicros: applied(frame.openPnlMicros, prev.openPnlMicros),
    dayPnlMicros: applied(frame.dayPnlMicros, prev.dayPnlMicros),
    remainingDrawdownMicros: applied(frame.remainingDrawdownMicros, prev.remainingDrawdownMicros),
    openContracts: frame.openContracts ?? prev.openContracts,
    marked: applied(frame.rules?.marked, prev.marked),
    unmarkable: applied(frame.unmarkable, prev.unmarkable),
  };
}
