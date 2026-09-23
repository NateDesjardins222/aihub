/**
 * The one font stack every canvas in the chart paints in.
 *
 * A canvas 2D context CANNOT resolve a CSS `var()` inside `ctx.font`: the whole
 * declaration is rejected and the context silently falls back to its 10px
 * sans-serif default. So the chart cannot read `--font-ui` from the theme the
 * way the DOM does — it needs a literal, valid font stack, and this is it. It is
 * the same DM Sans family the DOM chrome resolves `--font-ui` to, kept in sync by
 * hand and guarded by `canvas-font.test.ts`.
 *
 * DM Sans is a proportional sans, not a monospace face: the "old-computer"
 * engineering look this terminal deliberately does not have. Where digits must
 * align (a price axis, a readout), the caller asks the canvas for tabular
 * figures — the family itself is never monospaced.
 */
export const CHART_FONT_STACK =
  "'DM Sans Variable', 'DM Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/**
 * A valid canvas `font` shorthand for the chart's family.
 *
 * Shorthand order is `[weight] <size>px <family>` — anything else (a bare
 * `var(...)`, a missing unit) makes the context reject the whole string and
 * keep its previous font, which is how a label silently renders in the wrong
 * face. Building it here, once, keeps every call correct.
 */
export function chartFont(sizePx: number, weight: number | string = 500): string {
  return `${weight} ${sizePx}px ${CHART_FONT_STACK}`;
}
