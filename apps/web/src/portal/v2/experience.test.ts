/**
 * Experience Layer Phase 2 — structural proofs (no DB, no browser).
 *
 * Deterministic source-level invariants that keep the experience layer authoritative,
 * fixture-free, celebration-idempotent-by-construction, and reduced-motion safe.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/src/portal/v2
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');

const PROD_FILES = [
  'experience.tsx', 'experience.css', 'experience-celebration.tsx',
  'analytics-page.tsx', 'progress-page.tsx', 'containers.tsx',
];

describe('Experience Layer — fixture firewall holds', () => {
  for (const f of PROD_FILES.filter((f) => f.endsWith('.tsx'))) {
    it(`${f} imports no dev fixtures / cert-samples / Review harness`, () => {
      const src = read(f);
      expect(src, `${f} must not import fixtures`).not.toMatch(/['"]\.\.?\/.*fixtures['"]/);
      expect(src, `${f} must not import cert-samples`).not.toMatch(/cert-samples/);
      expect(src, `${f} must not import the dev Review harness`).not.toMatch(/['"]\.\/Review['"]|\/v2\/Review['"]/);
    });
  }
});

describe('Experience Layer — authoritative data only', () => {
  it('the celebration host reads the authoritative feed and acks server-side', () => {
    const src = read('experience-celebration.tsx');
    expect(src).toMatch(/\/api\/v1\/portal\/celebrations/);
    expect(src).toMatch(/\/api\/v1\/portal\/celebrations\/ack/);
    // No fabricated celebration data — it maps the server `pending` feed.
    expect(src).not.toMatch(/FIXTURE_|fakeCelebration/);
  });

  it('Analytics composes only authoritative endpoints (per-account analytics + payout history)', () => {
    const c = read('containers.tsx');
    expect(c).toMatch(/\/api\/v1\/portal\/accounts\/\$\{a\.id\}\/analytics/);
    expect(c).toMatch(/\/api\/v1\/portal\/payouts\/history/);
    expect(c).not.toMatch(/FIXTURE_/);
  });
});

describe('Experience Layer — tracked goals cannot be forged from the UI', () => {
  it('the goal checkbox is disabled for tracked goals and never calls complete for them', () => {
    const p = read('progress-page.tsx');
    // The checkbox disables on tracked and the toggle returns early for tracked goals.
    expect(p).toMatch(/disabled=\{tracked\}/);
    expect(p).toMatch(/if \(tracked\) return;/);
  });
});

describe('Experience Layer — reduced motion + accent tokens', () => {
  it('experience.css neutralises motion under prefers-reduced-motion', () => {
    const css = read('experience.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation: none !important/);
  });

  it('tokens.css defines the rose-gold accent and the glow hierarchy', () => {
    const t = read('tokens.css');
    expect(t).toMatch(/--ht-rose:/);
    expect(t).toMatch(/--ht-glow-low:/);
    expect(t).toMatch(/--ht-glow-high:/);
  });
});
