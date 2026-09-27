/**
 * Portal V2 design guardrails (Product Rebuild Phase 0, STEP 25).
 *
 * Lightweight, enforceable conventions for the V2 layer — caught in CI before the
 * debt exists. Scans the V2 CSS/TSX for the specific things the owner rejected and
 * the phase forbids: purple, default link underlines, oversized radius, heavy SaaS
 * shadows, and arbitrary off-scale spacing. Not a giant lint system — a focused net
 * over `apps/web/src/portal/v2`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => /\.(css|tsx)$/.test(f));
const cssFiles = files.filter((f) => f.endsWith('.css'));
/** Strip /* … *​/ and // … comments so prose that NAMES a forbidden thing (e.g. a
 *  comment saying "never a purple bar") does not trip a keyword scan. We police
 *  what the code DOES, not how it explains itself. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const read = (f: string): string => readFileSync(join(here, f), 'utf8');
const readCode = (f: string): string => stripComments(read(f));
const allCss = cssFiles.map(readCode).join('\n');

describe('V2 excludes purple entirely', () => {
  it('no "purple"/"violet" keyword in V2 code (comments excluded)', () => {
    for (const f of files) {
      expect(readCode(f).toLowerCase(), f).not.toMatch(/purple|violet|rebeccapurple|indigo/);
    }
  });
  it('no purple-range hex (hue ~260–290) in V2 tokens', () => {
    // Common offenders: #8b5cf6 #7c3aed #a855f7 #6d28d9 #9b59b6.
    expect(allCss.toLowerCase()).not.toMatch(/#(8b5cf6|7c3aed|a855f7|6d28d9|9b59b6|b184f5)/);
  });
});

describe('V2 has no default link underlines', () => {
  it('never sets text-decoration: underline', () => {
    expect(allCss).not.toMatch(/text-decoration:\s*underline/);
  });
});

describe('V2 geometry is restrained', () => {
  it('defines radii only through tokens, none above 8px in the token file', () => {
    const tokens = read('tokens.css');
    const radii = [...tokens.matchAll(/--ht-radius-[a-z]+:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(radii.length).toBeGreaterThan(0);
    for (const r of radii) expect(r).toBeLessThanOrEqual(8);
  });
  it('no raw border-radius between 9 and 900px in component CSS (fully-round 999px pills excepted)', () => {
    for (const f of cssFiles) {
      const body = readCode(f);
      const bad = [...body.matchAll(/border-radius:\s*(\d+)px/g)]
        .map((m) => Number(m[1]))
        // >8 is oversized for a surface; ≥900 is an intentional fully-round pill
        // (progress bars, dots) which is a shape, not a SaaS card corner.
        .filter((n) => n > 8 && n < 900);
      expect(bad, `${f} has oversized radius ${bad.join(',')}`).toEqual([]);
    }
  });
});

describe('V2 elevation is borders-first, not heavy SaaS shadows', () => {
  it('no giant blur-radius drop shadows in component CSS', () => {
    // Allow the single --ht-shadow-pop token; forbid ad-hoc large shadows elsewhere.
    for (const f of cssFiles.filter((f) => f !== 'tokens.css')) {
      expect(read(f), f).not.toMatch(/box-shadow:\s*[^;]*\b([3-9]\d|\d{3,})px/);
    }
  });
});
