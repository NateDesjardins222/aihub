# M6.1 — Production Certificate Master Integration + Visual Calibration — Report

Status: **COMPLETE** (one asset correction outstanding, see §12)
Branch: `claude/futures-trading-simulator-v8qefu`
Starting HEAD: `9829768` (Milestone 6 complete)
Ending HEAD: see the push confirmation (§14)

This was an **asset-integration + calibration** pass, not a new product milestone.
It replaced the non-production certificate fixtures with the approved Happy Trader
Funding V1 masters, calibrated deterministic dynamic-field rendering to the actual
master pixels, proved the rendered output matches the approved designs, and left
the certificate system production-asset-ready. No product/business rules changed;
no artwork was redesigned; no AI generation is used anywhere.

## 1. Commits

| Commit | Summary |
|---|---|
| `7f2da9d` | Integrate approved V1 masters + calibrate rendering + 30 production-template tests |
| (this doc) | M6.1 documentation |

## 2. Production template paths

```
certificate-templates/funded-trader/v1/{master.png,manifest.json}
certificate-templates/payout/v1/{master.png,manifest.json}
certificate-templates/account-completed/v1/{master.png,manifest.json}
certificate-templates/10k-club/v1/{master.png,manifest.json}
certificate-templates/50k-club/v1/{master.png,manifest.json}
```
`v-test` fixtures remain beside each as NON-PRODUCTION calibration artifacts. 100K
club has no digital master (manual plaque).

## 3. Source dimensions

All five approved masters: **1536 × 1024** px (converted losslessly from the
supplied WebP to PNG; decoded pixels only, no re-compression or resampling).

## 4. Dynamic fields per template

- funded-trader: `recipientName` (uppercase), `value` = account size `50K`, `date` `YYYY-MM-DD`.
- payout: `recipientName`, `value` = trader-share payout `$5,000`, `date`.
- account-completed: `recipientName`, `value` = cumulative paid `$25,000`, `date`.
- 10k-club: `recipientName`, `value` = LOCKED `$10,000`, `date` (dynamic; the corrected blank master replaced the earlier baked-date one — see §12).
- 50k-club: `recipientName`, `value` = LOCKED `$50,000`, `date`.

Everything else is baked artwork and is never touched.

## 5. Manifest coordinates (canvas 1536×1024)

See `docs/production-certificate-assets-v1.md` §"Calibrated manifest coordinates"
for the full table. Positions were measured from the actual master pixels (blank
placement-line detection) and verified with golden renders. recipientName y≈558–574
size 74; value y≈685–691 size 44 (centred in the caption→line gap); date
right-aligned x=1435 y≈102–111 size 30.

## 6. Font / fallback

`HappyTraderSans` (bundled OFL **DejaVu Sans**, `certificate-templates/_fonts/`):
weight 700 for recipient + value (bold grotesk to match the approved values),
weight 400 tracked for the date. No unauthorized/proprietary font was introduced.
The large chrome achievement headings are baked into each master and are not
re-created.

## 7. Renderer version

`rendererVersion = 'r1'` (unchanged). `renderHash = sha256(png + "type:version:r1")`.
The template version (`v1`) and renderer version are frozen onto each certificate
record at render time, so historical certificates never re-render.

## 8. Golden sample locations & visual regression method

- Golden renderer: `apps/server/scripts/render-golden-certs.mjs` (renders each v1
  template with the approved example values — `NATETRADEZ`, `2026-09-23`, per-type
  value — plus a long-name overflow case).
- Visual regression (automated, `certificate-production-templates.test.ts`):
  1. **Master fidelity** — rendering a template with **no field values** is
     pixel-identical to the master (proves the artwork is composited unchanged).
  2. **Field confinement** — rendering with the golden values changes pixels
     **only** inside the manifest field bounding boxes; every pixel outside is
     identical to the master (proves dynamic text never touches the artwork,
     lines, arrow or signature).
  Deterministic tolerance: static regions must be **exactly** identical; dynamic
  text is not required to be pixel-identical across platforms.
- Each of the five was also visually compared against the approved design during
  calibration (recipient position/centre/scale, date placement/tracking, value
  placement/size, no overlap/clipping) and adjusted until it matched.

## 9. PNG / PDF status

Every type renders a PNG and a print-ready single-page PDF (sized to the artwork,
`%PDF-` verified). Same input ⇒ identical `renderHash` (determinism test).

## 10. Physical-print readiness

**Digital: production-ready. Physical (11×14 framed): NOT yet.** 1536×1024 is
~110 DPI at 11×14 — below print quality. Higher-resolution masters (~4200×3300 for
300 DPI, at the exact print aspect) are required for physical printing. The current
masters are **not upscaled**. Digital issuance and on-screen/PDF delivery are
unaffected. The immutable print artifact remains the full-resolution PNG, tied to
`certificateId` + `templateVersion` + `rendererVersion` + `renderHash`.

## 11. 100K plaque handling

Unchanged and manual: excluded from `RENDERABLE_TYPES`, `isPhysicalEligibleType`,
the digital render pipeline and the framed-certificate commerce; never sent to
Prodigi. Fulfilled by owner operations through the existing 100K plaque queue.

## 12. Remaining blockers (asset corrections only — no code work)

1. **10K master baked date — RESOLVED.** The corrected blank 10K master (no baked
   date) was supplied and installed, and the dynamic `YYYY-MM-DD` date field was
   re-enabled in its manifest (x=1435, y=110, size 30), matching the other four
   types. `$10,000` remains the fixed rendered milestone; recipient stays dynamic.
2. **11×14 print-resolution masters** — supply ~4200×3300 masters to enable
   physical framed printing; re-calibrate manifests to the new canvas. (Only
   outstanding item.)

Everything else is done and green. No production credentials are required; Prodigi
stays disabled; no real order/charge is made.

## 13. Tests & acceptance

- **30 new deterministic production-template tests** (`certificate-production-templates.test.ts`):
  master+manifest load/validate, 1536×1024 canvas, each of the five renders
  (RENDERED, PNG, PDF, 64-hex hash), date/account-size/money formatting,
  determinism, long-name shrink, **static-region visual regression** (fidelity +
  confinement), production fail-closed + no-fixture-fallback, blank/markup/email
  name rejection, and 100K exclusion.
- **Full server regression: 906 tests / 88 files pass** (was 876; +30) on a fresh,
  migrated, seeded database, run single-threaded (`vitest run --no-file-parallelism`
  — the same pre-existing shared-default-org parallelism note from the M6 report
  applies).
- **Browser acceptance: 48/48** (`tests/browser/certificates-acceptance.spec.mjs`)
  against the live stack after re-rendering the demo certificates with the v1
  masters — the vault previews, image/PDF downloads, public verification, framed
  order, DAILY progression, theme, and owner store all pass, no console errors.
  The in-browser vault confirmed the v1 artwork (10K CLUB/$10,000, PAYOUT/$1,700,
  FUNDED TRADER/50K, recipient uppercase, dynamic dates).
- Monorepo typecheck, web `tsc`, and web `vite build` all pass.

## 14. Working tree / branch

Clean working tree; local `HEAD` equals `origin/claude/futures-trading-simulator-v8qefu`
after the push accompanying this report.
