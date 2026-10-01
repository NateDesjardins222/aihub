/**
 * Portal V2 scroll + shell architecture guardrails (Scroll/Shell Hotfix).
 *
 * These are CONTRACT tests, not layout tests (jsdom does no layout). They lock the
 * CSS declarations that make the workspace the single vertical scroll owner, so a
 * future edit that reintroduces the "content below the fold is unreachable" defect
 * fails here. The ACTUAL scroll MOVEMENT is proven in the real-browser regression
 * (scripts/portal-v2-scroll.mjs). They also lock the review shell's honest nav
 * (no dead links, Owner Console not baked in) and its routing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REVIEW_NAV, parseRoute } from './Review';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(join(here, f), 'utf8').replace(/\s+/g, ' ');

const shell = read('Shell.css');
const primitives = read('primitives.css');

/** Extract the declaration block for a selector (first match), whitespace-collapsed. */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector + ' {');
  if (i < 0) throw new Error(`selector not found: ${selector}`);
  const start = css.indexOf('{', i);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end).trim();
}

describe('Portal V2 scroll ownership — CSS contract', () => {
  it('the root (.htv2) is viewport-bound and never the scroller', () => {
    const b = block(primitives, '.htv2');
    expect(b).toMatch(/height:\s*100dvh/);
    expect(b).toMatch(/overflow:\s*hidden/);
  });

  it('the shell fills the root with a single bounded, shrinkable grid row', () => {
    const b = block(shell, '.htv2-shell');
    expect(b).toMatch(/height:\s*100%/);
    expect(b).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
  });

  it('the main column can shrink below content (min-height: 0)', () => {
    const b = block(shell, '.htv2-shell-main');
    expect(b).toMatch(/min-height:\s*0/);
  });

  it('the WORKSPACE is the vertical scroll owner (overflow-y:auto + min-height:0), no horizontal page overflow', () => {
    const b = block(shell, '.htv2-workspace');
    expect(b).toMatch(/overflow-y:\s*auto/);
    expect(b).toMatch(/min-height:\s*0/);
    expect(b).toMatch(/overflow-x:\s*hidden/);
  });

  it('a long sidebar scrolls independently without locking the shell', () => {
    const b = block(shell, '.htv2-side');
    expect(b).toMatch(/min-height:\s*0/);
    expect(b).toMatch(/overflow-y:\s*auto/);
  });
});

describe('Portal V2 — honest customer navigation (rebuilt at human-rejection #1)', () => {
  it('the sidebar shows only real customer destinations — no dev tooling, no owner', () => {
    const keys = REVIEW_NAV.map((n) => n.key);
    expect(keys).toEqual(['dashboard', 'accounts', 'payouts', 'certificates', 'progress', 'billing', 'support']);
    // The rejected entries are gone from customer navigation entirely.
    expect(keys).not.toContain('design');
    expect(keys).not.toContain('owner');
  });

  it('no nav item carries a dev/engineering tag', () => {
    for (const n of REVIEW_NAV) expect((n as { status?: string }).status).toBeUndefined();
  });

  it('every visible destination parses to a real page view', () => {
    expect(parseRoute('/portal-v2')).toEqual({ view: 'dashboard' });
    expect(parseRoute('/portal-v2/')).toEqual({ view: 'dashboard' });
    expect(parseRoute('/portal-v2/accounts')).toEqual({ view: 'accounts' });
    expect(parseRoute('/portal-v2/accounts/f-eval')).toEqual({ view: 'detail', id: 'f-eval' });
    expect(parseRoute('/portal-v2/payouts')).toEqual({ view: 'payouts' });
    expect(parseRoute('/portal-v2/certificates')).toEqual({ view: 'certificates' });
    expect(parseRoute('/portal-v2/progress')).toEqual({ view: 'progress' });
    expect(parseRoute('/portal-v2/billing')).toEqual({ view: 'billing' });
    expect(parseRoute('/portal-v2/support')).toEqual({ view: 'support' });
    // Owner is reachable (account menu, owners only) but is NOT a customer nav key.
    expect(parseRoute('/portal-v2/owner')).toEqual({ view: 'owner' });
    // The removed design-system route no longer resolves — it falls back to the dashboard.
    expect(parseRoute('/portal-v2/dev/design-system')).toEqual({ view: 'dashboard' });
    // Unknown sub-paths fall back to the dashboard, never a blank/trapped screen.
    expect(parseRoute('/portal-v2/nonsense')).toEqual({ view: 'dashboard' });
  });
});
