/**
 * Canvas font validation (Terminal Hardening V5, Phase 3).
 *
 * A canvas 2D context validates the WHOLE `ctx.font` string: if any part is
 * invalid — a bare `var(--font-ui)`, a missing `px` unit, a stray token — it
 * rejects the assignment silently and keeps its previous font, which defaults to
 * `10px sans-serif`. That is exactly how the drawing labels once rendered in the
 * wrong face while every code path "looked" like it set DM Sans.
 *
 * These guards keep the chart's font strings valid canvas shorthand, in the DM
 * Sans family, and never monospace — so the regression cannot come back
 * unnoticed. A real browser's parser is the ground truth, but jsdom's canvas is
 * a stub, so we validate the shorthand structurally against the CSS grammar the
 * canvas uses.
 */
import { describe, expect, it } from 'vitest';
import { CHART_FONT_STACK, chartFont } from './fonts';
import { labelFont } from './drawings/paint';

/**
 * `[style] [variant] [weight] [stretch] <size> <family>` — we only ever emit
 * `[weight] <size>px <family>`. A valid string starts with an optional weight,
 * then a size WITH a unit, then a non-empty family list.
 */
const VALID_CANVAS_FONT = /^(?:(?:normal|bold|[1-9]00)\s+)?\d+(?:\.\d+)?px\s+.+\S$/;

const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 20, 24];

describe('the chart font stack', () => {
  it('names DM Sans and no monospace face', () => {
    expect(CHART_FONT_STACK).toMatch(/DM Sans/);
    expect(CHART_FONT_STACK.toLowerCase()).not.toContain('monospace');
    expect(CHART_FONT_STACK.toLowerCase()).not.toContain('menlo');
    expect(CHART_FONT_STACK.toLowerCase()).not.toContain('mono');
    // It must end in a generic family so the browser always has a fallback.
    expect(CHART_FONT_STACK.trim()).toMatch(/sans-serif$/);
  });

  it('never smuggles a CSS var() into a value the canvas must parse', () => {
    // The canonical failure: `ctx.font = "13px var(--font-ui)"` is rejected
    // wholesale and the label paints in 10px sans-serif.
    expect(CHART_FONT_STACK).not.toContain('var(');
    for (const size of SIZES) {
      expect(chartFont(size)).not.toContain('var(');
      expect(labelFont(size)).not.toContain('var(');
    }
  });
});

describe('chartFont / labelFont emit valid canvas shorthand', () => {
  it('produces a parseable `[weight] <size>px <family>` at every size', () => {
    for (const size of SIZES) {
      expect(chartFont(size), `chartFont(${size})`).toMatch(VALID_CANVAS_FONT);
      expect(labelFont(size), `labelFont(${size})`).toMatch(VALID_CANVAS_FONT);
    }
  });

  it('carries the requested weight and size verbatim', () => {
    expect(chartFont(13, 600)).toBe(`600 13px ${CHART_FONT_STACK}`);
    expect(chartFont(11)).toBe(`500 11px ${CHART_FONT_STACK}`);
    // The drawing layer delegates to the same builder, so the two never drift.
    expect(labelFont(13, 600)).toBe(chartFont(13, 600));
    expect(labelFont(11)).toBe(chartFont(11));
  });

  it('actually applies to a real canvas context when one exists (no silent fallback)', () => {
    // No DOM (node env) or no 2D context (jsdom stub): skipped, not faked. In a
    // real browser this proves the string is accepted rather than dropped to the
    // 10px default.
    if (typeof document === 'undefined') return;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    const requested = chartFont(13, 600);
    ctx.font = requested;
    // A rejected font leaves the context at its default; an accepted one reports
    // a normalized form that still carries our size and family.
    expect(ctx.font).toMatch(/13px/);
    expect(ctx.font).not.toBe('10px sans-serif');
  });
});
