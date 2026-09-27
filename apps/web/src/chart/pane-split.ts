/**
 * Pane split adaptation — the pure math behind resizable indicator panes.
 *
 * A "split" is one stretch factor per pane, top (price) to bottom. The trader
 * drags a separator; the renderer changes the factors; we remember them. When
 * the pane COUNT changes (a study is added or removed) the remembered split must
 * be adapted to the new count WITHOUT throwing away the price pane's share the
 * trader chose. Kept pure (no chart-library import) so it is unit-testable.
 */

/**
 * Adapt a remembered split to `count` panes.
 *
 * - null / empty / fewer than 2 panes → null (no manual split; use automatic).
 * - same count → the split unchanged.
 * - different count → the price pane keeps its share; the panes below divide
 *   what was below it equally, so adding a study never shrinks the price pane.
 */
export function adaptSplit(manual: readonly number[] | null, count: number): number[] | null {
  if (!manual || manual.length === 0 || count < 2) return null;
  if (manual.length === count) return [...manual];
  const total = manual.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const price = manual[0] ?? 1;
  const below = Math.max(0, total - price);
  const others = count - 1;
  if (others <= 0) return [price];
  const each = below > 0 ? below / others : price / 3;
  return [price, ...Array.from({ length: others }, () => each)];
}

/**
 * The automatic split for `count` panes: the price pane keeps ~3/4, the rest
 * share the remainder. Returns null for a single pane (nothing to split).
 */
export function automaticSplit(count: number): number[] | null {
  if (count < 2) return null;
  const below = Math.max(1, count - 1);
  return [below * 3, ...Array.from({ length: count - 1 }, () => 1)];
}
