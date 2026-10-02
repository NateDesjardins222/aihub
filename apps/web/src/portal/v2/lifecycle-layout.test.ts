/**
 * V2Lifecycle overflow contract (Product Rebuild Phase 0, STEP 18).
 *
 * jsdom has no layout engine, so pixel overflow is asserted in a real browser by
 * scripts/portal-v2-lifecycle-overflow.mjs (1920/1440/1280/1024/768/390). Here we
 * pin the STRUCTURAL contract that makes overflow impossible — a grid of
 * minmax(0, 1fr) columns with shrinkable children and no fixed-width connectors —
 * plus the pure state→stage mapping. If a future edit reintroduces the V1 flex +
 * fixed-width `::after` pattern, this fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lifecycleActiveIndex, LIFECYCLE_STAGES } from './Lifecycle';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'Lifecycle.css'), 'utf8');

describe('V2Lifecycle structural overflow contract', () => {
  it('lays the path out as an N-column grid of shrinkable fractions', () => {
    expect(css).toMatch(/grid-template-columns:\s*repeat\(var\(--htv2-life-n[^)]*\),\s*minmax\(0,\s*1fr\)\)/);
  });

  it('lets each stage shrink below its content (min-width:0)', () => {
    expect(css).toMatch(/\.htv2-life-stage\s*\{[^}]*min-width:\s*0/s);
  });

  it('draws connectors that add no intrinsic width', () => {
    // Connectors are grid lines with min-width:0 — never a fixed-width flex ::after.
    expect(css).toMatch(/\.htv2-life-line\s*\{[^}]*min-width:\s*0/s);
    expect(css).not.toMatch(/\.htv2-life-line[^{]*\{[^}]*width:\s*\d+px/s);
  });

  it('does NOT reintroduce the V1 fixed-width ::after connector pattern', () => {
    // The V1 bug: `.pt-path-step::after { width: 26px }` inside a flex row.
    expect(css).not.toMatch(/::after\s*\{[^}]*width:\s*\d+px/s);
  });

  it('never hides broken content behind overflow:hidden on the row', () => {
    expect(css).not.toMatch(/\.htv2-life\s*\{[^}]*overflow:\s*hidden/s);
  });

  it('the label — not the track — is what clips when space is tight', () => {
    expect(css).toMatch(/\.htv2-life-label\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });
});

describe('lifecycleActiveIndex maps authoritative state → stage', () => {
  it('has exactly four stages in order', () => {
    expect([...LIFECYCLE_STAGES]).toEqual(['Evaluation', 'Funded', 'Payouts', 'Completed']);
  });
  it('evaluation states sit at stage 0', () => {
    expect(lifecycleActiveIndex('PENDING')).toBe(0);
    expect(lifecycleActiveIndex('EVALUATION_ACTIVE')).toBe(0);
  });
  it('passed has NOT reached Funded; funded has (the two are distinct)', () => {
    // EVALUATION_PASSED has completed Evaluation but is still being funded, so its
    // highest FULLY-reached stage is Evaluation (0), one short of FUNDED_ACTIVE (1).
    // This is the fix for the PASSED-vs-FUNDED conflation (Golden Path WEB-1).
    expect(lifecycleActiveIndex('EVALUATION_PASSED')).toBe(0);
    expect(lifecycleActiveIndex('FUNDED_ACTIVE')).toBe(1);
    expect(lifecycleActiveIndex('EVALUATION_PASSED')).not.toBe(lifecycleActiveIndex('FUNDED_ACTIVE'));
  });
  it('completed sits at stage 3', () => {
    expect(lifecycleActiveIndex('COMPLETED_MAX_PAYOUTS')).toBe(3);
  });
  it('failed/inactive have no highlight', () => {
    expect(lifecycleActiveIndex('FAILED')).toBe(-1);
    expect(lifecycleActiveIndex('INACTIVE_CLOSED')).toBe(-1);
    expect(lifecycleActiveIndex('ARCHIVED')).toBe(-1);
  });
});
