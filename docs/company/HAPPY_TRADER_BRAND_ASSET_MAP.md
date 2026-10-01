# Happy Trader — Brand Asset Map (Portal V2)

Authoritative record of the official Happy Trader Funding brand assets Nathan supplied,
how each was inspected, which derivatives exist and **why**, and the one rule that governs
all of it: **we never AI-generate, trace, retype, redraw or distort the brand.** Derivatives
are only mechanical transforms (transparency keying, trim, downscale, format) of a supplied
original, and every original is preserved untouched alongside its derivative.

All assets live in `apps/web/src/portal/v2/brand/`.

## Supplied originals (preserved, never edited)

| File | Format | Dimensions | Content | Transparency |
|------|--------|-----------:|---------|--------------|
| `happy-trader-funding-stacked.original.webp` | WebP | 1570 × 823 | Stacked lockup: chrome swoosh symbol above "HAPPY TRADER" / "FUNDING" wordmark | opaque (dark bg) |
| `happy-trader-funding-wordmark-wide.original.png` | PNG | 1669 × 298 | Wide horizontal wordmark lockup | opaque (RGB) |
| `happy-trader-symbol.original.webp` | WebP | 2000 × 1316 | The chrome symbol / swoosh mark alone | opaque (dark bg) |
| `happy-trader-funding-wordmark.original.jpg` | JPEG | 1579 × 255 | Earlier wide wordmark (prior phase) | opaque |

Originals are committed read-only (`chmod 600` artifacts of the import) and are **inputs only**:
no component imports an `.original.*` file.

## Derivatives (mechanical transforms only)

| File | From | Dimensions | Transform + reason |
|------|------|-----------:|--------------------|
| `happy-trader-funding-stacked.png` | stacked.original.webp | 640 × 317 | Luminance-keyed alpha (LO=4 / HI=22) to drop the solid dark frame so the lockup sits on our near-black surface; bounding-box trim; downscale to a web-appropriate 2× sidebar width. **PRIMARY sidebar brand.** |
| `happy-trader-symbol.png` | symbol.original.webp | 480 × 316 | Same transparency key + trim + downscale. **Not used in the sidebar** — the source retains a faint frame edge after keying, so it is held for future use (favicon/compact mark) rather than shipped where it would read as a seam. |
| `happy-trader-funding-wordmark.png` | wordmark.original.jpg | 1522 × 109 | Transparency key + trim of the earlier wide wordmark; used as the **mobile strip** lockup (height-constrained). |

### Why Playwright/Chromium (not PIL/sharp)
The container has no image library (`PIL`, `sharp`, node `canvas`). Derivatives were produced
with Playwright + the pre-installed Chromium (`/opt/pw-browsers/chromium`) driving an off-DOM
`<canvas>`: draw the original, read `getImageData`, key alpha by luminance, compute the opaque
bounding box, trim, downscale, re-encode PNG. This is a pixel-faithful mechanical transform —
no redraw, no vector tracing, no font substitution.

## Where each asset is used

| Context | Asset | Rendered size |
|---------|-------|---------------|
| Desktop sidebar brand | `happy-trader-funding-stacked.png` | `width: 158px` (`.htv2-side-logo-stacked`) |
| Mobile top strip | `happy-trader-funding-wordmark.png` | `height: 16px` (`.htv2-side-logo-wide`) |
| (reserved) compact mark | `happy-trader-symbol.png` | not shipped yet |

Wiring: `Shell.tsx` → `V2Wordmark({ variant })` picks the stacked vs. wide source; `Shell.css`
shows the stacked lockup on desktop and swaps to the wide wordmark under the 900px mobile
breakpoint. The sidebar width (`--ht-sidebar-w: 204px`) was widened specifically so the stacked
lockup reads at a premium size — directly addressing the "logo is WAY too small" rejection.

## Hard rules (do not violate in any future phase)
1. Preserve every supplied original untouched; add new originals as `*.original.*`.
2. Derivatives are mechanical only (alpha key / trim / scale / format). Never AI-generate,
   trace, retype, recolor the mark, or alter proportions.
3. If a brand treatment needs something the supplied assets can't give (e.g. a true
   single-color favicon), request the asset from Nathan — do not fabricate it.
4. The symbol derivative is quarantined from shipping surfaces until a clean-edged source
   is supplied, because keying its current source leaves a faint frame artifact.
