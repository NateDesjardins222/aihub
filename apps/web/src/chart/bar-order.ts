/**
 * Bar ordering guarantee for the chart series.
 *
 * lightweight-charts' `setData` throws (`checkItemsAreOrdered`) on unordered or
 * duplicate timestamps and then stops taking any further updates — which reads on
 * screen exactly like "the candles are wrong / misplaced / frozen". The server is
 * expected to return closed bars already sorted and unique, but the chart is the
 * layer lightweight-charts holds to that invariant, so it must not depend on an
 * upstream guarantee it cannot enforce: a boundary duplicate from a MIXED
 * cache/provider page, or a bar that arrives fractionally out of order, must never
 * be able to freeze the chart.
 *
 * Kept in its own module (no chart-library import) so it is unit-testable without
 * a DOM/canvas environment.
 */
import type { NormalizedBar } from '@atlas/contracts';

/**
 * Return a series the renderer can accept: strictly ascending by time with no
 * duplicate timestamps. When two bars share a timestamp the LAST one wins (a
 * later copy is a revision of the same bucket). A no-op (shallow copy) on the
 * common already-sorted, already-unique case.
 */
export function orderBarsAscendingUnique(bars: readonly NormalizedBar[]): NormalizedBar[] {
  let ordered = true;
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i]!.time <= bars[i - 1]!.time) {
      ordered = false;
      break;
    }
  }
  if (ordered) return [...bars];
  const byTime = new Map<number, NormalizedBar>();
  for (const bar of bars) byTime.set(bar.time, bar); // last-wins revision
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
