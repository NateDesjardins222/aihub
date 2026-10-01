# Portal V2 — Certificate Architecture

The Certificates surface is a categorised vault over the customer's **earned** certificates,
backed by the existing deterministic certificate renderer (Milestone 6). It previews, downloads
and verifies real artifacts; it never re-creates a certificate in CSS or fabricates a PDF.

## Data model
`Cert` (from `apps/web/src/portal/lib.tsx`): `id`, `certificatePublicId`, `verificationToken`,
`type`, `publicDisplayName`, `amountMicros`, `issuedAt`, and the Milestone-6 artifact state —
`renderStatus`, `hasImage`, `hasPdf`, `templateVersion`, `accountId`.

## Categories (the horizontal rail)
`All · Funded · Payouts · Account completion`, derived from `cert.type`:
- **Funded** → `FUNDED_TRADER`
- **Payouts** → `PAYOUT`
- **Account completion** → everything else (e.g. `ACCOUNT_COMPLETION`, evaluation passed)

The rail shows per-category counts and only renders a category tab when it has ≥1 certificate
(All always shows). Pure client-side filter over the already-fetched list.

## Artifact pipeline (honest wiring)
`V2CertificatesPage` is presentational and takes `actions`:
- `resolveArtifact(certId, kind)` → an **authenticated object URL** for the rendered artifact.
  - Production container: `GET /api/v1/portal/certificates/:id/{image,pdf}` with the bearer,
    `URL.createObjectURL(blob)` (an `<img>` cannot send a bearer, hence the blob indirection —
    the same mechanism V1 uses).
  - Dev review: returns `null` (no session) → the card shows "Preview available in your
    account". **No fake image is ever drawn.**
- `onVerify(token)` → opens the public verification page `/verify/:token`.

Each card: artifact preview well (image or truthful note), kind + issue date, display name,
amount (payouts), and actions — Download image / Download PDF (gated on `renderStatus ===
'RENDERED'` and `hasImage`/`hasPdf`), Verify, View account.

## Renderer reuse (not re-implemented)
The deterministic renderer and artifact storage from Milestone 6 remain the single source of
the artifact. Portal V2 **consumes** `/:id/{image,pdf}`; it does not render certificates. The
display name shown is the certificate's `publicDisplayName` — the customer's chosen public
identity, never their legal name (see PORTAL_V2_PROFILE_IDENTITY.md).

## Empty / zero states
No certificates → "No certificates yet" guidance. Zero-customer mode shows this truthfully.

## Seams / debt
- Physical ("framed") certificate commerce (`/order-framed`) exists in V1 and is **not yet**
  surfaced in V2 — tracked in PRODUCT_UX_DEBT.md.
- Achievements (distinct from certificates) are not yet a V2 surface.

---
## Review #3 — actual artwork is now the visual object
The vault was rejected (R2) for showing text/placeholder instead of the certificate. R3:
- Each tile IS the certificate: the real rendered artwork dominates (artwork-first tile),
  caption (type · amount · date) below. Click → a large preview modal with the full artifact +
  metadata (recipient, amount, issued, cert ID) + Download image / Download PDF / Verify / View account.
- Production fetches the customer's own artifact via the authenticated endpoint (bearer→blob).
- The dev review (no session) serves REAL renderer output as samples (`cert-samples.ts`), produced
  by `scripts/render-golden-certs.mjs` using the SAME `CanvasCertificateRenderer`, masters and fonts.
  These are the actual certificate artwork, not CSS — never fabricated. No production path imports them.
