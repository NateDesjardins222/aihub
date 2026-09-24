# Certificate Templates

Deterministic certificate rendering assets (Milestone 6). Each template **type**
has one directory; each **version** has its own subdirectory with the approved
`master.png` and a validated `manifest.json`. Code inserts only the approved
dynamic fields declared by the manifest — it never designs the certificate.

```
certificate-templates/
  _fonts/                     bundled OFL fonts (deterministic, open-licensed)
  funded-trader/
    v1/     master.png  manifest.json      <- APPROVED PRODUCTION (drop in here)
    v-test/ master.png  manifest.json      <- NON-PRODUCTION fixture (tests/dev)
  payout/            v1/ … v-test/ …
  account-completed/ v1/ … v-test/ …
  10k-club/          v1/ … v-test/ …
  50k-club/          v1/ … v-test/ …
  100k-club/                                 (no render master — manual plaque)
```

## Version resolution

At render time the service prefers `v1` (approved production) when its
`master.png` is present. The `v-test` fixture is used **only outside production**
(`NODE_ENV !== 'production'`) for local development and automated tests — in
production a missing/invalid `v1` fails **closed** (`render_status = DISABLED`,
no artifact; the reward is still earned and verifiable) and never falls back to
the non-production fixture. The version actually used is frozen onto the
certificate record, so historical certificates never re-render.

## What is here now (M6.1)

The **approved Happy Trader Funding V1 production masters** are installed for all
five digital certificate types (`funded-trader`, `payout`, `account-completed`,
`10k-club`, `50k-club`) at **1536×1024**. The `v-test` fixtures remain as clearly
marked NON-PRODUCTION calibration artifacts (`NON-PRODUCTION.txt`). The 100K club
is a **manual physical plaque** — it intentionally has no render master and is
never routed through the automated digital/Prodigi pipeline.

### Dynamic fields per type

| Type | recipientName | value | date |
|---|---|---|---|
| funded-trader | ✓ (uppercase) | account size `50K` | `YYYY-MM-DD` (top-right) |
| payout | ✓ | payout amount `$5,000` | `YYYY-MM-DD` |
| account-completed | ✓ | cumulative paid `$25,000` | `YYYY-MM-DD` |
| 10k-club | ✓ | locked `$10,000` | — (see below) |
| 50k-club | ✓ | locked `$50,000` | `YYYY-MM-DD` |

**10k-club date:** the supplied 10k master has a **baked sample date** in the
top-right, so its manifest omits the dynamic `date` field to avoid a double date.
Re-export the 10k master **without** the baked date and add the `date` field back
(copy the field block from `50k-club/v1/manifest.json`) to make it dynamic like
the others. This is the one outstanding asset correction (see the M6.1 report).

### Print resolution

1536×1024 renders a crisp on-screen certificate and a matching PDF, but at an
11×14 print it is ~110 DPI — **below print quality**. Digital issuance is fully
production-ready; physical (framed) printing needs higher-resolution masters
(~4200×3300 for 300 DPI). See `docs/production-certificate-assets-v1.md`. Do not
upscale the current masters.

## Adding / correcting an approved master

For each renderable type, place in `<type>/v1/`:

- `master.png` — the final approved artwork (RGB PNG). Keep the manifest
  `canvas` dimensions equal to the master's actual pixels.
- `manifest.json` — per `docs/certificate-template-manifest.md`: each dynamic
  field's position, a bundled `_fonts` family, size, weight, colour, alignment
  and overflow. Re-calibrate coordinates to the master's real pixels
  (`apps/server/scripts/measure-cert-masters.mjs` detects the placement lines;
  `apps/server/scripts/render-golden-certs.mjs` renders golden samples to verify).
