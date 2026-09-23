/**
 * Symbol search ranking.
 *
 * The old header filtered instruments with a single substring test over
 * `root + description + exchange`. Every instrument's description contains the
 * word "Futures", and "Futures" contains the substring "es" — so typing `ES`
 * matched all eight instruments and the list-order first row (NQ) won on Enter,
 * never the instrument the trader typed. This module ranks matches so an exact
 * (or prefix) root match always sorts ahead of an incidental description hit,
 * and exposes an explicit exact-match lookup so Enter can never select the wrong
 * symbol. Pure and framework-free, so it is unit-testable in isolation.
 */

export interface SearchableInstrument {
  readonly root: string;
  readonly description: string;
  readonly exchange: string;
  readonly displayName?: string;
}

/** Lower score = better match. Ordering, most-preferred first:
 * 0 exact root · 1 root prefix · 2 root substring · 3 text (name/desc/exchange). */
function matchScore(instrument: SearchableInstrument, needle: string): number | null {
  const root = instrument.root.toLowerCase();
  if (root === needle) return 0;
  if (root.startsWith(needle)) return 1;
  if (root.includes(needle)) return 2;
  const text = `${instrument.displayName ?? ''} ${instrument.description} ${instrument.exchange}`
    .toLowerCase();
  if (text.includes(needle)) return 3;
  return null;
}

/**
 * Instruments that match `query`, best first. An empty query returns the list
 * unchanged (its natural order). Ties keep the input order (a stable sort), so
 * the registry order still decides between two equally-good matches (e.g. `m`
 * lists the mini/micro pairs predictably).
 */
export function rankInstruments<T extends SearchableInstrument>(
  instruments: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...instruments];
  const scored: Array<{ item: T; score: number; index: number }> = [];
  instruments.forEach((item, index) => {
    const score = matchScore(item, needle);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => (a.score - b.score) || (a.index - b.index));
  return scored.map((s) => s.item);
}

/**
 * The instrument whose root exactly equals the query (case-insensitive), or
 * null. Used so that pressing Enter on a fully-typed, recognised symbol selects
 * exactly that symbol regardless of which row is currently highlighted.
 */
export function exactRootMatch<T extends SearchableInstrument>(
  instruments: readonly T[],
  query: string,
): T | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return null;
  return instruments.find((i) => i.root.toLowerCase() === needle) ?? null;
}

/**
 * The instrument Enter should select given the current query and highlighted
 * row. An exact root match always wins (the trader typed a real symbol); other-
 * wise the highlighted row; otherwise the best-ranked match. Never returns a
 * stale or wrong symbol, and returns null only when nothing matches at all.
 */
export function resolveEnterSelection<T extends SearchableInstrument>(
  instruments: readonly T[],
  query: string,
  highlightedIndex: number,
): T | null {
  const ranked = rankInstruments(instruments, query);
  if (ranked.length === 0) return null;
  const exact = exactRootMatch(ranked, query);
  if (exact) return exact;
  return ranked[highlightedIndex] ?? ranked[0] ?? null;
}
