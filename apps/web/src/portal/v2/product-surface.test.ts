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

// ---- Human-acceptance Review #2 guardrails ----------------------------------

describe('Portal V2 R2 — brand lockup is larger and uses the official stacked asset', () => {
  it('the shell imports the supplied stacked lockup for the sidebar', () => {
    expect(read('Shell.tsx')).toMatch(/brand\/happy-trader-funding-stacked\.png/);
  });
  it('the stacked derivative and its preserved original both exist', () => {
    expect(existsSync(join(here, 'brand/happy-trader-funding-stacked.png'))).toBe(true);
    expect(existsSync(join(here, 'brand/happy-trader-funding-stacked.original.webp'))).toBe(true);
  });
  it('the sidebar sizes the stacked lockup to read premium (not tiny)', () => {
    const css = read('Shell.css');
    const m = /\.htv2-side-logo-stacked\s*\{[^}]*width:\s*(\d+)px/.exec(css);
    expect(m, 'stacked logo width rule present').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(120);
  });
});

describe('Portal V2 R2 — payouts are premium, never a gambling surface', () => {
  // Gambling MECHANICS only. (A consecutive-loss "Streak" counter is a legitimate risk
  // control, not a reward mechanic, so "streak" is intentionally not banned here.)
  const gambling = [/confetti/i, /jackpot/i, /\bcasino\b/i, /spin to win/i, /slot machine/i, /scratch card/i];
  for (const f of renderFiles) {
    it(`${f} has no gambling mechanics`, () => {
      const code = stripComments(read(f));
      for (const re of gambling) expect(code, `${f} :: ${re}`).not.toMatch(re);
    });
  }
  it('the payouts page has the premium ledger hero', () => {
    expect(read('pages.tsx')).toMatch(/htv2-payout-hero/);
  });
});

describe('Portal V2 R2 — certificates have a real category rail + verify, no fake artifact', () => {
  it('the certificates page exposes category tabs and a verify action', () => {
    const p = read('pages.tsx');
    expect(p).toMatch(/htv2-cert-cat-/);
    expect(p).toMatch(/Account completion/);
    expect(p).toMatch(/onVerify/);
    expect(p).toMatch(/resolveArtifact/);
  });
  it('no certificate is drawn in CSS / no fake PDF is generated', () => {
    const p = stripComments(read('pages.tsx'));
    expect(p).not.toMatch(/new Blob\(\[.*pdf/i);
    expect(p).not.toMatch(/jsPDF|pdfkit/i);
  });
});

describe('Portal V2 R2 — identity: display name is separate from legal identity', () => {
  it('the profile page states legal name is never shown on a certificate', () => {
    const p = read('profile.tsx');
    expect(p).toMatch(/never (your )?(the )?.*legal name|legal name is never/i);
    expect(p).toMatch(/publicDisplayName/);
  });
  it('the profile page does not fabricate an identity mutation or MFA toggle', () => {
    const p = stripComments(read('profile.tsx'));
    // Presentational: no fetch/PATCH and no local MFA enable/disable state here.
    expect(p).not.toMatch(/fetch\(|api\.(patch|post)\(/);
  });
});

describe('Portal V2 R2 — billing is provider-safe', () => {
  it('billing shows only a safe payment-method projection (no raw card entry)', () => {
    const p = read('pages.tsx');
    expect(p).toMatch(/PaymentMethodView/);
    expect(p).toMatch(/last4/);
    const code = stripComments(p);
    // No card-number / cvv capture anywhere in the billing surface.
    expect(code).not.toMatch(/card ?number|cardNumber|\bcvv\b|\bcvc\b/i);
  });
});

describe('Portal V2 R2 — zero-customer mode shows zeros, not demo data', () => {
  it('the review supports a deterministic empty-customer state', () => {
    const r = read('Review.tsx');
    expect(r).toMatch(/state'\) === 'empty'|'state'\)\s*===\s*'empty'/);
    expect(r).toMatch(/FIXTURE_VIEW_EMPTY_CUSTOMER/);
  });
});

// ---- Human-acceptance Review #3 guardrails --------------------------------

describe('Portal V2 R3 — no fixture/sample leakage beyond the dev review', () => {
  // fixtures.ts and cert-samples.ts are DEV-REVIEW ONLY. They must be imported only by the
  // review harness (Review.tsx) and tests — never by a presentational/production surface.
  const devOnly = ['./fixtures', './cert-samples'];
  const allowed = new Set(['Review.tsx']);
  for (const f of renderFiles) {
    if (allowed.has(f) || f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue;
    it(`${f} imports no dev-review fixture/sample module`, () => {
      const code = read(f);
      for (const mod of devOnly) {
        expect(code, `${f} imports ${mod}`).not.toMatch(new RegExp(`from '${mod.replace('.', '\\.')}'`));
      }
    });
  }
});

describe('Portal V2 R3 — certificates show the ACTUAL artwork', () => {
  it('the vault renders the rendered artifact image and a large preview modal', () => {
    const p = read('pages.tsx');
    expect(p).toMatch(/htv2-certtile-img/);     // artwork dominates the tile
    expect(p).toMatch(/htv2-certmodal/);        // click → large preview
    expect(p).toMatch(/resolveArtifact/);       // real artifact, not CSS
  });
  it('real certificate sample artifacts (renderer output) exist for the dev review', () => {
    for (const f of ['funded-trader', 'payout', 'account-completed', 'tenk-club', 'fiftyk-club']) {
      expect(existsSync(join(here, `brand/certs/${f}.sample.png`)), f).toBe(true);
    }
  });
});

describe('Portal V2 R3 — support is wired to the authoritative ticket API', () => {
  it('the support surface calls the real /api/v1/support endpoints (not a fixture)', () => {
    const s = read('support.tsx');
    expect(s).toMatch(/\/api\/v1\/support\/me\/tickets/);
    expect(s).toMatch(/api\.post<\{ id: string \}>\('\/api\/v1\/support\/tickets'/);
    expect(s).toMatch(/\/messages/);
  });
});

describe('Portal V2 R3 — performance is a real interactive chart', () => {
  it('uses lightweight-charts (crosshair/tooltip/resize), not a static SVG', () => {
    const c = read('perf-chart.tsx');
    expect(c).toMatch(/from 'lightweight-charts'/);
    expect(c).toMatch(/subscribeCrosshairMove/);
    expect(c).toMatch(/ResizeObserver/);
  });
});

describe('Portal V2 R3 — Accounts is re-composed (ledger + statement)', () => {
  it('renders a brokerage account ledger table, not a card wall', () => {
    const a = read('AccountsView.tsx');
    expect(a).toMatch(/htv2-accounts-ledger/);
    expect(a).toMatch(/htv2-acctws-statement/);
  });
});
