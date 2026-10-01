# Certificate Existing-System Audit (forensic trace, Review #3)

Read-only trace of the certificate system BEFORE touching any UI, so Portal V2 **consumes**
the existing deterministic renderer rather than rebuilding it. Everything below already
exists (Milestone 6 / M6.1) and is tested.

## Database record
`certificates` table — `apps/server/src/db/schema.ts` (~L1854). Key columns:
`id`, `organizationId`, `certificatePublicId` (unique `HT-C-…`), `verificationToken` (unique),
`type`, `customerIdentityId` (ownership spine, FK cascade), `accountId` (nullable),
`publicDisplayName` (the SAFE printed name — frozen at issuance, never the legal name),
`amountMicros`, `status` (`ISSUED`/`REVOKED`), `templateVersion`, `rendererVersion`,
`renderStatus` (`PENDING`/`RENDERED`/`FAILED`/`DISABLED`), `imageStorageKey`/`pdfStorageKey`,
`renderHash` (sha256 determinism proof), `milestoneValueMicros`, `dedupeKey` (exactly-once),
`issuedAt`.

## Renderer (deterministic — NOT re-implemented in V2)
- `apps/server/src/platform/certificate-renderer.ts` — `CanvasCertificateRenderer`,
  `RENDERER_VERSION='r1'`; composites manifest fields onto the approved `master.png` via
  `@napi-rs/canvas`; PNG→PDF via `pdfkit`. Same inputs → identical output + `renderHash`.
- `apps/server/src/platform/certificate-manifest.ts` — loads `manifest.json` + `master.png`,
  registers OFL fonts.
- `apps/server/src/platform/certificate-render-service.ts` — orchestration (idempotent),
  resolves template version, writes artifacts to the object store, freezes keys+hash.

## Supported types / templates
`certificate-templates/<type>/<version>/{manifest.json,master.png}`. **Renderable** (v1 masters
present): `FUNDED_TRADER`, `PAYOUT`, `ACCOUNT_COMPLETED`, `TENK_CLUB`, `FIFTYK_CLUB`.
`EVALUATION_PASSED` and `HUNDREDK_CLUB` have **no approved master** → render `DISABLED`
(documented limitation, not faked).

## Artifact storage
`apps/server/src/platform/object-store.ts` — `ObjectStore` (put write-once/get/exists);
`LocalObjectStore` under a confined dir; `S3ObjectStoreSeam` throws `NOT_CONFIGURED`. Keys are
opaque (`certificates/<org>/<uuid>/<publicId>.png|.pdf`) — **no filesystem path is exposed to
clients**; retrieval is always via an authenticated streaming route.

## HTTP endpoints (what Portal V2 consumes)
- `GET /api/v1/portal/certificates` → `{ certificates: [...] }` (identity-scoped list). Each
  item carries `id, certificatePublicId, verificationToken, type, accountId, publicDisplayName,
  amountMicros, status, renderStatus, hasImage, hasPdf, templateVersion, issuedAt`.
- `GET /api/v1/portal/certificates/:id/image` and `/pdf` — `requireUser`; owner-checked; streams
  bytes with `content-disposition: attachment`, `cache-control: private, no-store`. (An `<img>`
  can't send a bearer, so the client fetches a blob and uses an object URL — the mechanism V2 uses.)
- `GET /api/v1/verify/:token` — **public**, rate-limited; returns only safe fields (valid, status,
  publicId, type, publicDisplayName, amountMicros, issuedMonth). No enumeration signal.

## Ownership
`ownedCertificateArtifact` (`apps/server/src/platform/certificates.ts` ~L289): resolves the
caller's `customerIdentities` row, selects the cert by `id` AND `customerIdentityId`, requires
`status='ISSUED'` + `renderStatus='RENDERED'` + non-null key. Any miss → null → route 404. No IDOR.
Covered by `certificate-security.routes.test.ts`.

## Recipient name source
The printed name is the frozen `certificates.publicDisplayName`, derived at issuance from
`customerIdentities.preferredDisplayName` (the SAFE public name) with a `First L.` fallback — never
the legal name/email. Changing the preferred name affects only certs issued afterward (snapshot).

## What was missing (and how Review #3 addresses it)
- Portal V2 vault previously showed placeholders only. **Fixed:** the vault now renders the actual
  artifact (authenticated endpoint in production; real renderer output as dev-review samples where
  there is no session) — see PORTAL_V2_CERTIFICATE_ARCHITECTURE.md and `cert-samples.ts`.
- Nothing in the engine was rebuilt. V2 is a consumer only.
