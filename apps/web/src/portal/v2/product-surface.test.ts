/**
 * Portal V2 customer-surface guardrails (human-rejection #1 repair).
 *
 * Locks the three things the human rejection was most explicit about, so they can't
 * silently regress:
 *   1. the brand is the SUPPLIED wordmark image, and the old fake square mark is gone;
 *   2. the customer product contains NO dev tooling / engineering language;
 *   3. navigation exposes no Design-system / DEV / Owner-Console destination.
 * Source-level scans here; the live-DOM equivalents run in scripts/portal-v2-review.mjs.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REVIEW_NAV } from './Review';
import { PORTAL_V2_NAV } from './Shell';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(join(here, f), 'utf8');
/** Strip comments so prose that NAMES a banned thing ("no Design system") doesn't trip the scan. */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every V2 source file that can render into the customer product. */
const renderFiles = readdirSync(here).filter((f) => /\.(tsx|ts)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));

describe('Portal V2 brand — supplied wordmark, no fake mark', () => {
  it('the shell imports and renders the supplied Happy Trader Funding wordmark asset', () => {
    const shell = read('Shell.tsx');
    expect(shell).toMatch(/brand\/happy-trader-funding-wordmark\.png/);
    expect(shell).toMatch(/htv2-wordmark/);
    expect(shell).toMatch(/alt="Happy Trader Funding"/);
  });
  it('the supplied wordmark asset and its preserved original both exist in the repo', () => {
    expect(existsSync(join(here, 'brand/happy-trader-funding-wordmark.png'))).toBe(true);
    expect(existsSync(join(here, 'brand/happy-trader-funding-wordmark.original.jpg'))).toBe(true);
  });
  it('the old fake square brand mark is gone', () => {
    const shellTsx = read('Shell.tsx');
    const shellCss = read('Shell.css');
    expect(shellTsx).not.toMatch(/htv2-side-mark/);
    expect(shellCss).not.toMatch(/htv2-side-mark/);
  });
});

describe('Portal V2 customer product — zero dev tooling / engineering language', () => {
  // Distinctive phrases that only appear as dev/showcase CONTENT, never legitimate
  // customer copy. (Generic tokens like "DEV" are checked against the live DOM, not
  // source, to avoid matching words like "development" in code.)
  const banned = [
    /Design system/i,
    /design-system/i,
    /overflow-proof/i,
    /\b220px\b/i,
    /representative values/i,
    /component (showcase|harness)/i,
    /status showcase/i,
  ];
  for (const f of renderFiles) {
    it(`${f} contains no customer-facing engineering content`, () => {
      const code = stripComments(read(f));
      for (const re of banned) expect(code, `${f} :: ${re}`).not.toMatch(re);
    });
  }
  it('the design-system harness file has been removed entirely', () => {
    expect(existsSync(join(here, 'Harness.tsx'))).toBe(false);
  });
});

describe('Portal V2 navigation — no dev or owner destinations', () => {
  it('neither the customer nav nor the review nav exposes design/dev/owner', () => {
    for (const nav of [PORTAL_V2_NAV, REVIEW_NAV]) {
      const keys = nav.map((n) => n.key);
      expect(keys).not.toContain('design');
      expect(keys).not.toContain('owner');
      expect(keys).not.toContain('dev');
    }
  });
});
