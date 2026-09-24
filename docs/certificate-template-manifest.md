# Certificate Template Manifest (Milestone 6)

Every certificate template **version** ships a `manifest.json` beside its
`master.png`. The manifest declares the canvas and the approved dynamic fields with
their exact positions and typography. Field coordinates are **never** hard-coded in
application code — the renderer reads them from the validated manifest, so moving a
field is a template change, not a code change.

## Location

```
certificate-templates/
  <type>/                     # funded-trader | payout | account-completed | 10k-club | 50k-club
    <version>/                # v1, v2, … ; v-test for NON-PRODUCTION fixtures
      master.png              # approved artwork (or a labelled non-production fixture)
      manifest.json
  _fonts/                     # bundled OFL fonts only
```

(`100k-club` needs no automated render master in V1 — it is a manual physical
plaque.)

## Shape

```json
{
  "templateType": "PAYOUT",
  "version": "v1",
  "renderable": true,
  "canvas": { "width": 3300, "height": 2550 },
  "fields": {
    "recipientName": {
      "x": 1650, "y": 1180, "width": 2400,
      "fontFamily": "DMSans", "fontSize": 120, "fontWeight": 700,
      "letterSpacing": 0, "color": "#111113",
      "alignment": "center", "maxLines": 1, "overflow": "shrink"
    },
    "amount": { "x": 1650, "y": 1520, "width": 1600, "fontFamily": "DMSans",
      "fontSize": 96, "fontWeight": 600, "alignment": "center", "maxLines": 1, "overflow": "shrink" },
    "date":   { "x": 1650, "y": 1760, "width": 1600, "fontFamily": "DMSans",
      "fontSize": 54, "fontWeight": 400, "alignment": "center", "maxLines": 1, "overflow": "shrink" }
  }
}
```

Each certificate type declares only its approved fields (see the family table in
`docs/rewards-certificates-v1.md`): recipient name always; plus account size /
payout amount / total / milestone value; plus the earned/paid/completion date.

## Field properties

| Property | Meaning |
| --- | --- |
| `x`, `y` | anchor point in canvas pixels (center for `alignment:center`) |
| `width` | max text box width in pixels; drives shrink/wrap |
| `fontFamily` | must resolve to a bundled registered font |
| `fontSize` | base size in px |
| `fontWeight` | numeric weight the bundled font provides |
| `letterSpacing` | px between glyphs (optional, default 0) |
| `color` | hex fill |
| `alignment` | `left` \| `center` \| `right` |
| `maxLines` | 1 = single line; >1 permits deterministic wrapping |
| `overflow` | `shrink` (reduce size to fit) \| `clip` \| `ellipsis` |

## Validation (before any render)

`validateManifest` rejects, deterministically, with a specific error:

- missing required top-level keys (`templateType`, `version`, `canvas`, `fields`)
- a `templateType` that does not match the directory / requested type
- malformed or non-positive canvas dimensions, or dimensions beyond a sane cap
- a field missing required properties (`x`, `y`, `width`, `fontFamily`, `fontSize`)
- coordinates outside the canvas, or non-finite / negative sizes
- an unsupported `fontFamily` (not a bundled registered font)
- an unsupported `alignment` / `overflow` / non-integer `maxLines`
- duplicate field definitions (JSON object keys are unique, so this is enforced by
  requiring every *expected* field for the type to be present exactly once and
  rejecting unknown fields)
- `renderable: false` or a missing `master.png` ⇒ the type renders as
  `DISABLED` (fail-safe), never a broken image

A manifest that fails validation aborts the render safely (the reward is still
issued; `render_status = FAILED`/`DISABLED`).

## Determinism

The manifest + master + resolved field values + `rendererVersion` fully determine
the output. Because the manifest is versioned alongside the master, a design change
is a new `<version>` directory with its own manifest; previously issued certificates
keep their frozen `templateVersion` and are never re-laid-out.

---

## M6.1 update — calibrated V1 manifests

The five V1 manifests are calibrated to the actual 1536×1024 master pixels
(canvas `{width:1536,height:1024}`), with fields `recipientName` (center, Sans 700,
74), `value` (center, Sans 700, 44) and `date` (right, Sans 400, 30) on all five
(the 10K's corrected blank master replaced the earlier baked-date one). Field positions
were measured from the masters' blank placement lines
(`apps/server/scripts/measure-cert-masters.mjs`) and verified with golden renders
(`apps/server/scripts/render-golden-certs.mjs`). Full coordinate table:
`docs/production-certificate-assets-v1.md`. When installing a corrected or
higher-resolution master, keep `canvas` equal to the master's real pixels and
re-calibrate the field coordinates.
