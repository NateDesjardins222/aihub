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
`master.png` is present; otherwise it falls back to `v-test` (fixture) for local
development and automated tests; otherwise the certificate is issued with
`render_status = DISABLED` and no artifact (the reward is still earned and
verifiable). The version actually used is frozen onto the certificate record, so
historical certificates never re-render.

## What is here now

Only **NON-PRODUCTION** `v-test` fixtures (clearly watermarked). They exist for
automated tests and local development and are **not** the approved production
artwork.

## Required from the design owner (see the M6 report)

For each renderable type, drop into `<type>/v1/`:

- `master.png` — the final approved artwork at production resolution
  (recommended ≥ 3300×2550 px for an 11×14 print at 300 DPI; RGB PNG).
- `manifest.json` — following `docs/certificate-template-manifest.md`: canvas
  dimensions matching the master, and each dynamic field's position, font
  (a bundled `_fonts` family), size, weight, colour, alignment and overflow.

Production issuance for a type stays **disabled** until its `v1/master.png` +
valid manifest are installed. The 100K plaque needs no render master in V1.
