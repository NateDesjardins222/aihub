# Certificate Rendering Architecture (Milestone 6)

Certificates are **deterministic software artifacts**, not AI images. The pipeline:

```
LOCKED MASTER TEMPLATE (approved artwork, immutable)
      ↓
SERVER-AUTHORITATIVE ACHIEVEMENT EVENT
      ↓
DETERMINISTIC FIELD INSERTION (only approved dynamic fields, from the manifest)
      ↓
FINAL IMMUTABLE RENDER (PNG + print-ready PNG + PDF)
      ↓
DATABASE REWARD RECORD (storage keys + render hash + frozen versions)
      ↓
OBJECT STORAGE
      ↓
CERTIFICATE VAULT → NOTIFICATION / VERIFICATION / OPTIONAL PHYSICAL ORDER
```

The renderer **never** designs the certificate, regenerates the background, alters
the logo/chrome/signature, chooses typography dynamically, moves fields, rewrites
wording, or invents values. It composites only the approved dynamic fields defined
by the template manifest onto the approved master.

## `CertificateRenderer` abstraction

`apps/server/src/platform/certificate-renderer.ts` exposes a versioned, replaceable
renderer:

```
interface CertificateRenderer {
  readonly version: string;            // rendererVersion, frozen onto each certificate
  render(input: RenderInput): Promise<RenderOutput>;
}
interface RenderInput {
  templateType: string;                // e.g. 'PAYOUT'
  templateVersion: string;             // e.g. 'v1'
  fields: Record<string, string>;      // resolved dynamic values (already formatted)
}
interface RenderOutput {
  png: Buffer;                         // dashboard/high-resolution
  printPng: Buffer;                    // print-ready (full master resolution)
  pdf: Buffer;                         // print-ready PDF
  renderHash: string;                  // sha256 over the canonical artifact bytes
  width: number; height: number;
}
```

### Determinism contract

Same `templateType` + `templateVersion` + `fields` + `rendererVersion` ⇒
functionally identical output and an identical `renderHash`. Layout is fully
specified by the manifest (positions, font, size, weight, alignment, max lines,
overflow); text width is measured with the bundled font so shrink-to-fit and
centering are deterministic. No dependence on a client viewport, wall clock, locale,
or network.

### Implementation

- **Raster**: `@napi-rs/canvas` — prebuilt, no system dependencies. Loads the master
  PNG, registers the bundled OFL font, measures + draws each manifest field
  (alignment, `overflow: "shrink"` reduces font size until the text fits `width`;
  `maxLines` bounds wrapping), exports PNG.
- **PDF**: `pdfkit` (pure JS) wraps the print-resolution PNG into a single-page
  print-ready PDF sized to the artwork.
- **Hash**: sha256 over the print PNG bytes plus the frozen `templateType:version:
  rendererVersion` — the structural proof the artifact matches its inputs.

The library sits behind the interface; swapping it (e.g. to `resvg` + `pdfkit`)
only bumps `rendererVersion`, which is frozen per certificate so history is stable.

### Fonts

Only bundled, permissively-licensed (OFL) fonts under
`certificate-templates/_fonts/`. No proprietary font files. The manifest's
`fontFamily` maps to a registered bundled family; an unsupported family fails
validation (below).

## Master assets & fail-safe

Approved production masters live under `certificate-templates/<type>/<version>/`
(`master.png` + `manifest.json`). See the manifest doc for structure and the M6
report for the exact assets required from the user.

- If a type's **approved production master is absent**, production rendering for that
  type **fails safe**: the reward record is still issued (the achievement is earned),
  but `render_status = 'DISABLED'`, no artifact is stored, and the Vault shows a
  "preview pending" state. Verification still works (the record is valid).
- **NON-PRODUCTION fixtures** live under `certificate-templates/<type>/v-test/` and
  are clearly labelled non-production. They exist only for automated tests and local
  development and are never presented as the approved artwork.

## Storage

Artifacts are written through the `ObjectStore` abstraction
(`apps/server/src/platform/object-store.ts`): a `LocalObjectStore` (filesystem, dev
+ tests) and a provider-ready S3 seam, selected by env. Domain records store opaque
storage **keys**, never disk paths. Keys are content/id-derived and unguessable;
artifacts are never silently overwritten (write-once per key). Retrieval is through
an **authenticated** portal route that streams from the store (owner-scoped), plus a
controlled public verification rendering.

## Download formats

High-resolution PNG and PDF at minimum, generated from the master at production
resolution (never an upscaled thumbnail). Physical fulfillment uses the dedicated
`printPng` / PDF print profile.

## Render status lifecycle

`render_status`: `PENDING` (record issued, render queued) → `RENDERED` (artifacts
stored) → or `FAILED` (transient error; retryable) / `DISABLED` (no approved master
for this type/version). The reward is valid regardless of render status.
