/**
 * D-02 — symbol search Enter selects the wrong symbol.
 *
 * Reproduction of the exact user report and proof of the fix. The registry
 * descriptions all contain "Futures", which contains the substring "es", so the
 * old substring filter matched every instrument on the query "es" and Enter
 * took the list-order first row (NQ) instead of ES.
 */
import { describe, expect, it } from 'vitest';
import { rankInstruments, exactRootMatch, resolveEnterSelection } from './symbol-search';

// The eight tradeable roots in registry order, with their real descriptions.
const INSTRUMENTS = [
  { root: 'NQ', description: 'E-mini Nasdaq-100 Index Futures', exchange: 'CME' },
  { root: 'MNQ', description: 'Micro E-mini Nasdaq-100 Index Futures', exchange: 'CME' },
  { root: 'ES', description: 'E-mini S&P 500 Index Futures', exchange: 'CME' },
  { root: 'MES', description: 'Micro E-mini S&P 500 Index Futures', exchange: 'CME' },
  { root: 'GC', description: 'Gold Futures (100 troy ounces)', exchange: 'COMEX' },
  { root: 'MGC', description: 'Micro Gold Futures (10 troy ounces)', exchange: 'COMEX' },
  { root: 'CL', description: 'Light Sweet Crude Oil Futures (1,000 barrels)', exchange: 'NYMEX' },
  { root: 'MCL', description: 'Micro WTI Crude Oil Futures (100 barrels)', exchange: 'NYMEX' },
];

describe('symbol search ranking (D-02)', () => {
  it('the old bug: "es" is a substring of "Futures" in every description', () => {
    // Proves WHY the naive filter failed — this is the reproduction.
    const naive = INSTRUMENTS.filter((i) =>
      `${i.root} ${i.description} ${i.exchange}`.toLowerCase().includes('es'),
    );
    expect(naive).toHaveLength(8);
    expect(naive[0]!.root).toBe('NQ'); // Enter would have selected NQ, not ES.
  });

  it('typing "ES" ranks ES first (exact root beats an incidental "Futures" hit)', () => {
    const ranked = rankInstruments(INSTRUMENTS, 'ES');
    expect(ranked[0]!.root).toBe('ES');
  });

  it('the exact reported case: GC active, type ES, Enter → ES', () => {
    // highlightedIndex 0 is what a fresh query resets to.
    const chosen = resolveEnterSelection(INSTRUMENTS, 'ES', 0);
    expect(chosen?.root).toBe('ES');
  });

  it('Enter selects the exact recognised symbol for the whole pair matrix', () => {
    const pairs: Array<[string, string]> = [
      ['NQ', 'ES'], ['ES', 'NQ'], ['GC', 'ES'], ['ES', 'GC'],
      ['CL', 'NQ'], ['MNQ', 'MES'], ['MES', 'MGC'], ['MGC', 'MCL'],
    ];
    for (const [, target] of pairs) {
      const chosen = resolveEnterSelection(INSTRUMENTS, target, 0);
      expect(chosen?.root, `typing ${target} + Enter`).toBe(target);
    }
  });

  it('an exact root match wins even if a stale highlight points elsewhere', () => {
    // Simulate a stale highlightedIndex (user arrowed down then retyped).
    const chosen = resolveEnterSelection(INSTRUMENTS, 'CL', 5);
    expect(chosen?.root).toBe('CL');
  });

  it('lowercase and surrounding whitespace still resolve exactly', () => {
    expect(resolveEnterSelection(INSTRUMENTS, '  es ', 0)?.root).toBe('ES');
    expect(exactRootMatch(INSTRUMENTS, 'mcl')?.root).toBe('MCL');
  });

  it('a prefix like "M" groups the micros ahead of a description-only hit', () => {
    const ranked = rankInstruments(INSTRUMENTS, 'M');
    // Every micro root starts with M; they must precede any text-only match.
    expect(ranked.slice(0, 4).map((i) => i.root)).toEqual(['MNQ', 'MES', 'MGC', 'MCL']);
  });

  it('an empty query returns the full list unchanged', () => {
    expect(rankInstruments(INSTRUMENTS, '').map((i) => i.root)).toEqual(
      INSTRUMENTS.map((i) => i.root),
    );
  });

  it('a query that matches nothing returns nothing (no wrong fallback)', () => {
    expect(rankInstruments(INSTRUMENTS, 'ZZZZ')).toHaveLength(0);
    expect(resolveEnterSelection(INSTRUMENTS, 'ZZZZ', 0)).toBeNull();
  });
});
