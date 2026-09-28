/**
 * Latest-request guard (Product Rebuild Phase 2, Parts XIII/XIV).
 *
 * A tiny, pure, testable mechanism for the "last write wins by intent" discipline:
 * every async load/mutation issues a monotonically increasing token; only the most
 * recently issued token is "latest". A response whose token is no longer latest is
 * discarded, so a slow A → fast B → slow-A-arrives sequence never paints A's stale
 * result over B, and an out-of-order mutation response never overwrites the newer
 * authoritative state.
 *
 * Extracted so the race behaviour is unit-tested independently of React.
 */
export interface LatestGuard {
  /** Begin a new attempt; returns its token and makes it the latest. */
  issue(): number;
  /** True only if `token` is still the most recently issued one. */
  isLatest(token: number): boolean;
}

export function latestGuard(): LatestGuard {
  let counter = 0;
  return {
    issue: () => (counter += 1),
    isLatest: (token: number) => token === counter,
  };
}
