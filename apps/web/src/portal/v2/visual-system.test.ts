/**
 * Portal V2 visual-system guardrails (Full Rebuild). Contract tests that lock the
 * premium visual direction so a future edit can't silently regress it:
 *  - the UI face is Inter (not the old DM Sans "dev-site" look);
 *  - no purple primary and no default browser-blue link colour in V2 tokens/CSS;
 *  - navigation has no permanent underline.
 * These complement scroll-architecture.test.ts (scroll + routing + honest nav).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Strip CSS comments so guards test actual declarations, not descriptive prose
// (the token file's own comments literally say "NOT purple, NOT amber-gold").
const read = (f: string): string => readFileSync(join(here, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const type = read('type.css');
const tokens = read('tokens.css');
const primitives = read('primitives.css');
const shell = read('Shell.css');

describe('Portal V2 typography', () => {
  it('uses Inter Variable as the V2 UI face', () => {
    expect(type).toMatch(/--ht-font:\s*'Inter Variable'/);
    expect(type).not.toMatch(/--ht-font:\s*'DM Sans/);
  });
  it('enables tabular numerals for financial values', () => {
    expect(type).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe('Portal V2 colour discipline', () => {
  const all = tokens + primitives + shell + type;
  it('has no purple / violet in V2 styling', () => {
    expect(all).not.toMatch(/purple|violet|indigo|rebeccapurple/i);
  });
  it('has no default browser-blue link colour', () => {
    // No raw blue link hexes; links use muted token colour.
    expect(all).not.toMatch(/#0000ee|#0645ad|#1a0dab|color:\s*blue/i);
    expect(primitives).toMatch(/\.htv2-link[\s\S]*color:\s*var\(--ht-text-muted\)/);
  });
  it('keeps the champagne accent token-based (no scattered bright gold hexes)', () => {
    expect(tokens).toMatch(/--ht-champagne:/);
    expect(all).not.toMatch(/#ffd700|#ffcc00|gold\b/i);
  });
});

describe('Portal V2 navigation styling', () => {
  it('never underlines nav by default (underline only on hover for text links)', () => {
    // The nav link rule sets text-decoration: none; the only underline is a :hover on .htv2-link.
    expect(shell).toMatch(/text-decoration:\s*none/);
  });
});
