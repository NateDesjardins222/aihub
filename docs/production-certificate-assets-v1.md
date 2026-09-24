# Production Certificate Assets V1

The authoritative record of the approved Happy Trader Funding V1 certificate
masters, how they are calibrated, and exactly what (if anything) is still needed
before physical printing.

## Installed masters

All five **digital** certificate types have an approved production master +
calibrated manifest under `certificate-templates/<type>/v1/`:

| Type | Directory | Master | Canvas |
|---|---|---|---|
| Funded Trader | `funded-trader/v1/` | `master.png` | 1536×1024 |
| Payout | `payout/v1/` | `master.png` | 1536×1024 |
| Account Completed | `account-completed/v1/` | `master.png` | 1536×1024 |
| $10K Club | `10k-club/v1/` | `master.png` | 1536×1024 |
| $50K Club | `50k-club/v1/` | `master.png` | 1536×1024 |
| $100K Club (plaque) | — | — | manual physical plaque; no digital master |

The artwork is used **exactly as supplied** — no logo, chrome arrow, signature,
border, colour, baked typography or spacing was altered. A per-type static-region
pixel test proves every pixel outside the dynamic-field boxes is identical to the
master. There is **no AI generation** anywhere in the pipeline.

The `v-test` fixtures remain beside each `v1` as clearly marked NON-PRODUCTION
calibration artifacts (`NON-PRODUCTION.txt`). In production (`NODE_ENV=production`)
the renderer only uses `v1` and never falls back to a fixture; a missing/invalid
`v1` fails closed (`render_status = DISABLED`).

## Dynamic fields (only these are inserted; everything else is baked artwork)

| Type | recipientName | value | date |
|---|---|---|---|
| Funded Trader | uppercase name | account size `50K` (from account config) | `YYYY-MM-DD` top-right |
| Payout | uppercase name | actual trader-share payout `$5,000` | `YYYY-MM-DD` |
| Account Completed | uppercase name | cumulative paid trader-share `$25,000` | `YYYY-MM-DD` |
| $10K Club | uppercase name | LOCKED `$10,000` | `YYYY-MM-DD` |
| $50K Club | uppercase name | LOCKED `$50,000` | `YYYY-MM-DD` |

- **Date** — `YYYY-MM-DD` in UTC from the reward's authoritative event timestamp
  (`certificates.issued_at`), never the browser clock or a locale format
  (`isoDate()` in `certificate-render-service.ts`).
- **Recipient** — the immutable `public_display_name` snapshot (taken at issuance)
  rendered in uppercase presentation; the stored snapshot keeps its original
  casing. Long names shrink deterministically to a documented floor and never
  overflow into the arrow, side lines, heading or signature.
- **Account size** — compact `NNK` form (`50K`, `300K`) via `accountSize()`.
- **Money** — canonical thousands (`$5,000`, `$25,000`), cents only when a real
  amount carries them, via `money()`.
- **Club value** — the LOCKED milestone label ($10,000 / $50,000), never the
  actual lifetime crossing total (that total is retained in metadata only).

## Calibrated manifest coordinates (canvas 1536×1024)

Font: `HappyTraderSans` (bundled DejaVu Sans; `_fonts/`) — 700 for recipient +
value, 400 for date. Colours `#F5F6F8` (recipient/value), `#C9CCD3` (date).

| Type | recipientName (x,y,size) | value (x,y,size) | date (x[right],y,size) |
|---|---|---|---|
| funded-trader | 768,569,74 | 768,690,44 | 1435,111,30 |
| payout | 768,565,74 | 768,689,44 | 1435,103,30 |
| account-completed | 768,558,74 | 768,685,44 | 1435,102,30 |
| 10k-club | 768,573,74 | 768,691,44 | 1435,110,30 |
| 50k-club | 768,574,74 | 768,690,44 | 1435,109,30 |

recipientName width 980, value width 720, date width 360; all shrink-to-fit,
recipient/value centered, date right-aligned. Positions were measured from the
actual master pixels (`apps/server/scripts/measure-cert-masters.mjs` detects the
blank placement lines) and verified with golden renders
(`apps/server/scripts/render-golden-certs.mjs`).

## OUTSTANDING asset corrections

1. **10K master baked date — RESOLVED.** The corrected blank 10K master (no baked
   date) is installed and its manifest now renders the dynamic `YYYY-MM-DD` date
   like the other four types (field at x=1435, y=110, size 30). No further action.

2. **Print resolution for the 11×14 framed certificate.** The masters are
   1536×1024 (~110 DPI at 11×14). That is crisp on screen and in the PDF, but
   **below print quality**. Physical framed printing needs higher-resolution
   masters — approximately **4200×3300 px** for 300 DPI at 14×11 in (landscape),
   at the exact print aspect ratio. When supplied, drop them into the same
   `<type>/v1/master.png` paths and update each manifest `canvas` to the new
   dimensions; the field coordinates scale with the canvas and must be
   re-calibrated (re-run the measure + golden scripts). **The current masters are
   NOT upscaled** — digital issuance is production-ready; physical print is gated
   on higher-resolution artwork.

## 100K plaque

The blank 100K plaque artwork/reference remains a **manual physical reward**. It
is intentionally not installed as a digital `v1` master, is excluded from the
digital render pipeline and from the automated framed-certificate commerce, and
is never submitted to Prodigi. Owner operations fulfil it manually through the
existing 100K plaque queue (`physical_reward_fulfillment`, `PLAQUE_100K`).
