# PRODUCT REBUILD — PRESERVATION MAP

**Product Rebuild Phase 0 (STEP 1-2).** The explicit boundary between the **proven backend/behavioral
foundation to PRESERVE** and the **presentation layer to REBUILD**, so the Portal V2 visual rebuild never
accidentally rewrites a tested system. From checkpoint `9f74a5f` (Engineering Phase B complete; canonical
214 files / 2994 tests; 0 reported P0/P1).

## Engineering baseline recorded (STEP 1)

- **Atlas engineering checkpoint:** `9f74a5f`. Interaction mechanics verified (Phase A candle truth +
  Phase B coordinate/tick/OCO/reconnect/ownership). `ATLAS_INTERACTION_ARCHITECTURE.md`.
- **Portal behavioral checkpoint:** customer Portal is functionally complete (dashboard, accounts,
  account detail, payouts, certificates, achievements, billing, support, profile/MFA) over
  owner-scoped `/api/v1/portal` routes; money is server-authoritative micro-dollars.
- **Canonical:** 214 files / 2994 tests passing.
- **Known P0/P1:** 0 reported. Known human-review items: external candle parity, chart-tool feel,
  per-chart account decision, and now **Portal presentation quality** (this rebuild).

## Classification legend

- **PRESERVE** — proven; do not touch in the visual rebuild.
- **PRESERVE + RECONNECT** — logic/data stays; V2 presentation re-binds to the same source.
- **PRESENTATION REPLACE** — behavior/structure stays; only the visual layer is rebuilt.
- **DEFER** — not part of Portal V2 Phase 0/rebuild; revisit later.
- **DO NOT TOUCH** — safety-critical; changing it risks money/trust.

## Systems

| System | Classification | Notes |
|---|---|---|
| Authentication / session | **DO NOT TOUCH** | Sign-in gate in `App.tsx`; V2 harness renders before the gate, dev-only. |
| Identity / KYC | **DO NOT TOUCH** | Server-authoritative, fail-closed. |
| RBAC (owner vs trader) | **DO NOT TOUCH** | Owner Console visibility gated server + client; V2 sidebar shows Owner entry only when `showOwner`. |
| Account data / projections | **PRESERVE + RECONNECT** | `AccountSummary`/`Analytics` view models feed V2 via a projection (`V2AccountView`), never raw rebind of money math. |
| Product configuration | **DO NOT TOUCH** | Versioned canonical config. |
| Risk engine / personal risk gate | **DO NOT TOUCH** | Server-authoritative. |
| Risk controls (Controls tab) | **PRESERVE** (visual replace later) | `ControlsView` behavior stays; V2 restyles in the account-detail rebuild, not Phase 0. |
| Orders / positions / execution | **DO NOT TOUCH** | Atlas terminal; Phase A/B verified. |
| Payout engine / lifecycle | **DO NOT TOUCH** | Eligibility/state machine/ledger server-side. |
| Payout presentation (`PayoutsPage`/`PayoutModule`/`PayoutMethodsPage`) | **PRESENTATION REPLACE** | V2 restyle; server calls unchanged. |
| Certificates (engine + vault) | **PRESERVE + RECONNECT** | `CertificatesPage` presentation replaced; verification/render untouched. |
| Achievements | **PRESERVE + RECONNECT** | Presentation replaced. |
| Billing | **PRESENTATION REPLACE** | `BillingPage`. |
| Support (tickets/disputes) | **PRESERVE + RECONNECT** | `SupportPage` presentation replaced; ticket domain untouched. |
| Owner Console access | **DO NOT TOUCH** | Separate `/admin` app; only the Portal's *entry link* is restyled. |
| Notifications | **PRESERVE** | Backend + outbox untouched. |
| Atlas routing (Trade →) | **PRESERVE** | The `?account=` hand-off stays; V2 keeps the same navigation. |
| Copy trading | **DO NOT TOUCH** | Config in Copy panel; DOM status only (Phase A). |
| Chart engine / market data / drawing tools | **DO NOT TOUCH** | Atlas terminal; not part of Portal V2. |
| Portal navigation (shell) | **PRESENTATION REPLACE** | Horizontal top-nav → V2 app shell (sidebar + topbar). Routes/route parsing preserved. |
| Portal dashboard | **PRESENTATION REPLACE** | `DashboardPage` → reference-driven V2 dashboard; same data. |
| Account cards | **REBUILD (presentation)** | `AccountCard`/`AccountPath` → `V2AccountPanel`/`V2Lifecycle` (overflow fixed structurally). |
| Account detail presentation | **PRESENTATION REPLACE** | Tabs (Overview/Performance/Controls/Rules/Activity) preserved; visuals rebuilt later. |
| Global theme (`styles/theme.css`) | **PRESERVE** | Atlas terminal theme; V2 tokens are a separate `--ht-*` layer scoped to `.htv2`, so the terminal is untouched. |

## The one rule

**No backend, product-rule, payout-rule, risk-rule, or execution code changes in the visual rebuild.**
Portal V2 replaces presentation and re-binds to the same authoritative view models. Anything marked DO
NOT TOUCH stays exactly as verified at `9f74a5f`.
