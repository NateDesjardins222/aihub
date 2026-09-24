# Milestone 6 — Happy Trader Rewards Engine, Certificate Vault, Physical Certificate Commerce & Daily Payout Progression V1 — Completion Report

Status: **COMPLETE**
Branch: `claude/futures-trading-simulator-v8qefu`
Starting HEAD: `931aa5f` (Milestone 5 complete)
Ending HEAD: `f0835a9` (before this report commit)

This milestone delivers two joined systems on top of the existing HTF platform:

- **(A) Rewards & Certificates** — automatic recognition of trader achievements, exactly-once issuance of certificates rendered **deterministically from a locked master template (no AI image generation anywhere in the pipeline)**, a permanent Certificate Vault with view / download / share / verify, notifications, a public verification page, and optional physical (framed) certificate commerce.
- **(B) Daily payout progressive qualifying balance** — a new locked rule for DAILY funded accounts: each successive Daily payout must qualify at a **strictly higher account balance** than the previous approved Daily payout.

All existing locked product rules (CORE / SELECT / DAILY specs, five active accounts, five payout cycles, 90/10 split, consistency and buffer rules, caps and minimums) are preserved and unchanged. Every migration is additive.

---

## 1. Commits (checkpoints)

| Commit | Checkpoint | Summary |
|---|---|---|
| `5ae9c7c` | M6-A | Architecture docs: rewards/certificates, rendering, manifest, physical commerce, daily progression |
| `7862ab6` | M6-B | Daily progressive qualifying-balance rule + `account.completed` producer |
| `a96637f` | M6-C | Rewards domain — rendered-artifact certificate columns, club tiers, delivery + 100K plaque tables (migration 0025) |
| `79f5c37` | M6-D | Deterministic certificate renderer + object storage + template manifests |
| `2e6397c` | M6-E | Reward triggers, exactly-once issuance, rendering + delivery |
| `4ee0892` | M6-F | Certificate Vault + owner-scoped artifact download + verification |
| `5556236` | M6-G/H | Physical framed certificate commerce + fulfillment provider seam (migration 0026) |
| `5a89377` | M6-I | Owner Certificate Store operations + 100K manual plaque fulfillment |
| `509d30f` | M6-J | Daily payout progression display + demo seed + route security tests |
| `39c5cfa` | M6-J | **Fix:** certificate issuance idempotent under any unique-index race |
| `f0835a9` | M6-J | Milestone 6 certificate + daily-progression real-browser acceptance |

(Migration 0024, the Daily-progression column, ships with the M6-B backend commit.)

---

## 2. Database migrations (additive only)

| Migration | Adds |
|---|---|
| `0024_daily_payout_progression.sql` | `payout_requests.qualifying_balance_at_approval` (micros) — the balance snapshot taken at the exactly-once approval/debit boundary |
| `0025_rewards_certificates.sql` | Certificate rendered-artifact columns (`renderer_version`, `render_status`, `image_storage_key`, `print_storage_key`, `pdf_storage_key`, `render_hash`, `render_error`, `milestone_value_micros`); new tables `reward_delivery`, `physical_reward_fulfillment` (unique `(org, customer_identity, type)`) |
| `0026_physical_certificate_orders.sql` | `physical_certificate_orders` (unique `(fulfillment_provider, provider_order_id)`) |

All three are registered in `apps/server/drizzle/meta/_journal.json` and were verified to apply cleanly on a **freshly created database** via the normal `tsx src/db/migrate.ts` path (not only by hand). No column was dropped or retyped; every add is nullable or defaulted.

---

## 3. (A) Rewards & Certificates

### Architecture (locked pipeline)
```
LOCKED MASTER TEMPLATE  →  SERVER-AUTHORITATIVE EVENT  →  DETERMINISTIC FIELD INSERTION
   →  IMMUTABLE RENDER  →  DB RECORD  →  OBJECT STORAGE  →  VAULT
   →  NOTIFICATION / PUBLIC VERIFICATION / OPTIONAL PHYSICAL ORDER
```
There is **no image-generation model anywhere** in the production path. A certificate image is produced by drawing the approved master PNG and inserting text fields at manifest-defined coordinates with bundled fonts.

### Certificate family
`FUNDED_TRADER`, `PAYOUT`, `ACCOUNT_COMPLETED`, `TENK_CLUB` ($10K), `FIFTYK_CLUB` ($50K), `HUNDREDK_CLUB` ($100K, physical plaque).

Club thresholds are computed from **LIFETIME actual trader-share PAID payouts only** (`achievements.ts` sums `trader_share_micros` over PAID payouts). The certificate prints the **locked milestone label** ($10k/$50k/$100k, stored in `milestone_value_micros`), never the raw lifetime total.

### Recognition triggers (server-authoritative, idempotent)
A deferred bystander subscriber (`recognition.ts`) listens to `evaluation.qualified`, `account.funded`, `payout.paid`, and `account.completed`. It issues achievements + certificates and crosses club milestones on `payout.paid`. It never blocks or fails the originating transaction (deferred `setTimeout(0)`, all errors swallowed).

M5 shipped no producer for `account.completed`; M6-B adds it in `markPaid` at the fifth PAID payout (status → `COMPLETED`, publishes `account.completed` with the lifetime trader-share total).

### Exactly-once
Issuance dedupes on a unique `(organization_id, dedupe_key)` index with `ON CONFLICT DO NOTHING`. Because the public certificate id is **deterministic** from `(org, dedupeKey)`, a true concurrent duplicate can collide on the *global* `certificate_public_id` index instead of the named target — which `ON CONFLICT` would let escape as a 23505 error. **M6-J fix (`39c5cfa`)**: issuance now treats *any* unique violation as the "already issued" outcome and returns the existing row, so exactly-once holds under real concurrency (proven by the concurrent-issuance test).

### Renderer & storage
- `@napi-rs/canvas` (prebuilt, no system deps) draws the master + fields; `pdfkit` embeds the PNG into a print-ready PDF.
- `renderer_version` is frozen at `r1`. `render_hash = sha256(png + "type:version:rendererVersion")` makes a render reproducible and verifiable.
- Fonts are vendored (DejaVu, re-registered as HappyTraderSans/Serif) so rendering is deterministic and offline.
- Object storage is behind an `ObjectStore` interface: `LocalObjectStore` (write-once, path-traversal-safe key validation, content-type sidecar) for dev, with an `S3ObjectStoreSeam` disabled by default. `OBJECT_STORE_PROVIDER` / `ARTIFACT_STORE_DIR` select it.

### Template manifest (no hardcoded coordinates)
`certificate-manifest.ts` loads `certificate-templates/<type>/<version>/{master.png,manifest.json}`. The manifest (strict zod schema) declares each field's position, size, font, weight, colour and alignment. `drawField` shrinks text to fit. If a master is missing, the template is **fail-safe DISABLED** (certificate is still issued and recorded, render status `DISABLED`) — issuance is never blocked by a missing asset.

### Customer display name (safe, snapshotted, immutable)
The certificate uses the customer's `preferredDisplayName` (reused as the certificate display name), validated (`validateCertificateDisplayName`: rejects blank, >60 chars, control chars, `< >`, and `@`). The safe name is **snapshotted at issuance** into `public_display_name` and never changes afterward.

### Vault, download, verification, notifications
- Portal **Certificate Vault** (`CertificatesPage.tsx`): filters (All / Funded / Payouts / Milestones / Completed), the rendered image as the visual hero, download image/PDF, copy verification link, and the framed-order flow.
- Artifacts stream through owner-scoped routes `GET /api/v1/portal/certificates/:id/{image,pdf}` — a certificate the caller does not own returns **404** (no IDOR); unauthenticated returns **401**.
- Public `GET /api/v1/verify/:token` + `/verify/:token` page expose **safe fields only** (type, public display name, month, amount/milestone, public id) — never an email, legal name, account id, or internal identifier. Unknown/revoked tokens return an explicit invalid state.
- `CERTIFICATE_READY` notification (EMAIL channel) enqueued on delivery through the existing outbox.

---

## 4. (B) Daily payout progressive qualifying balance

New locked rule, DAILY model only: each successive Daily payout requires a **strictly higher** qualifying account balance than the balance used for the previous approved Daily payout.

- `qualifying_balance_at_approval` is snapshotted at the single exactly-once approval/debit boundary (`approvePayout`, `balanceBefore`).
- Eligibility (pure `payout-core.ts`, re-run under the approval lock): if `previousDailyQualifyingBalance != null && balance <= previous`, push reason **`DAILY_BALANCE_PROGRESSION_NOT_MET`**. Integer micro-dollar comparison, no floats. First Daily payout (null previous) is inert.
- The rule **stacks with all existing gates** (winning days, consistency, buffer, withdrawable minimum, holds, one-pending, max cycles). It is purely additive.
- Eligibility projection always returns `previousDailyQualifyingBalanceMicros`, `currentQualifyingBalanceMicros`, `requiredNextQualifyingBalanceMicros` (null on non-DAILY / first payout). The portal `PayoutModule` renders a Daily qualifying-balance card (previous / current / required-next / remaining) and the blocked reason.
- A `MAX_CYCLES_REACHED` reason and the completion producer close the five-cycle lifecycle.

---

## 5. Physical certificate commerce (disabled by default)

- **Premium Framed Certificate**, 11×14, **$99.99** retail (`PHYSICAL_RETAIL_MICROS = 99_990_000`), SKU **`GLOBAL-CFP-11X14`**.
- `FulfillmentProvider` abstraction: `MockFulfillmentProvider` (idempotent `providerOrderId = sha256(idempotencyKey)`, quote ≈ **$62** = $52 item + $10 ship — **assumed, not hardcoded elsewhere**) and a `ProdigiFulfillmentProvider` **seam that refuses to run** unless `PRODIGI_ENABLED=true` **and** an API key is present. **No real Prodigi order or charge is ever made.**
- Server-authoritative order state machine: `PENDING_PAYMENT → PAID → preflight → SUBMITTED → SHIPPED → DELIVERED` (or `FULFILLMENT_FAILED`). **Preflight** re-checks ownership, render status, physical eligibility, render hash, artifact existence, known SKU, address, live quote, and that cost < retail before any manufacture call.
- Only **earned + rendered** certificates are orderable (`physicalEligible`). Merch **never provisions a trading account** — `physical_certificate_orders` is self-contained.
- **100K plaque = MANUAL fulfillment**: no provider, no auto-spend. It lands in `physical_reward_fulfillment` (`PLAQUE_100K`, `PENDING_REVIEW`) and is advanced by an operator through the owner Certificate Store.
- Flags: `MERCH_ENABLED` (default **false**), `PRODIGI_ENABLED` (default **false**), `PRODIGI_API_KEY`, `PRODIGI_ENV`.

---

## 6. Owner operations

Owner **Certificate Store** (`/admin/certificate-store`, SUPPORT reads / ADMIN mutations): revenue / cost / contribution summary over paid orders, order queue with ship/deliver/refund/replace/cancel transitions, and the manual 100K plaque queue (verify → order → ship → deliver / hold / cancel). Every mutation is audited. **There is no owner path that issues an EARNED certificate** — owner views are operational only; recognition remains server-authoritative.

---

## 7. Security

- Artifact IDOR: owner-scoped streams; foreign id → 404, unauthenticated → 401 (route tests + browser).
- Public verification exposes safe fields only; no email/legal/account/internal id (route tests + browser assert no `@`, no internal handle, no identifiers in page HTML).
- Display-name injection/email rejected at the profile boundary (400).
- No secrets in the browser; Prodigi/merch disabled by default; production seed scripts refuse to run when `NODE_ENV=production`.
- All locked money/product rules preserved; additive migrations only.

---

## 8. Tests & acceptance

**Deterministic tests — 88 new M6 cases (requirement ≥50):**

| File | Cases |
|---|---|
| `payout-daily-progression.test.ts` | 17 |
| `certificate-render.test.ts` | 26 |
| `config/env.test.ts` | 4 |
| `rewards-issuance.test.ts` (incl. concurrent exactly-once) | 11 |
| `physical-commerce.test.ts` | 14 |
| `certificate-store.test.ts` | 6 |
| `http/routes/certificate-security.routes.test.ts` | 10 |
| **Total** | **88** |

**Browser acceptance — `tests/browser/certificates-acceptance.spec.mjs`, 48–50 assertions (requirement ≥30):** vault nav + load, rendered artifact hero, five filters, owner PNG/PDF streaming, artifact + order IDOR (404) and unauthenticated (401), the $99.99 / 11×14 framed order flow through mock fulfillment, public verification safe-fields + invalid state, the **DAILY progression card and blocked reason end-to-end** (dedicated fixture), per-trader vault persistence across reload and account switch, dark/light theme, no console errors, and the owner Certificate Store. (Assertion count varies 48–50 because the order-flow branch is skipped once every seeded certificate already has an order — both branches pass.)

**Full regression:** the entire server suite (**876 tests / 87 files**) passes on a freshly created, migrated, and seeded database. The monorepo typecheck (`pnpm -r typecheck`), the web `tsc --noEmit`, and the web `vite build` all pass.

**Flake / execution note:** the server suite must be run **single-threaded** against a **seeded** database. A set of pre-existing trading-integration tests (`owner-exposure`, `money-oracle`, `rules.integration`) compute over the **shared default org** and collide under vitest's default file parallelism; `schema.test.ts` depends on the reference data created by `db:seed`. These are pre-existing repository characteristics, unrelated to Milestone 6. Reproduce the green baseline with:
```
createdb atlas_test  # fresh
DATABASE_URL=…/atlas_test tsx src/db/migrate.ts
DATABASE_URL=…/atlas_test tsx src/db/seed.ts
TEST_DATABASE_URL=…/atlas_test vitest run --no-file-parallelism
```

---

## 9. Certificate template status & production assets required

The rendering pipeline, manifest schema, fonts, and object storage are complete and proven with **`v-test` fixtures** for all five renderable types. The renderer resolves **`v1` if installed, else `v-test`** (`resolveTemplateVersion`). Production issuance renders `DISABLED` (still recorded and issued) for any type whose approved `v1` master is not yet installed.

**To go live you must supply the approved master artwork.** For each renderable certificate type, place two files in the repo:

```
certificate-templates/<type>/v1/master.png       # the LOCKED approved master image (print-resolution PNG)
certificate-templates/<type>/v1/manifest.json     # field coordinates/fonts (mirror the v-test manifest's schema)
```

Required `<type>` directories (kebab keys already scaffolded):

| Type | Directory | Needs `v1/master.png` + `v1/manifest.json`? |
|---|---|---|
| Funded Trader | `funded-trader` | **Yes** |
| Payout | `payout` | **Yes** |
| Account Completed | `account-completed` | **Yes** |
| $10K Club | `10k-club` | **Yes** |
| $50K Club | `50k-club` | **Yes** |
| $100K Club (plaque) | — | **No** — manual physical plaque; not machine-rendered |

Each `manifest.json` must validate against the strict schema (see `docs/certificate-template-manifest.md`), declaring the fields `recipientName`, `value`, and `date` (positions/fonts to taste). The bundled font families are `HappyTraderSans` (Regular/Bold) and `HappyTraderSerif` (Regular); to use a different typeface, add the `.ttf` under `certificate-templates/_fonts/` and register it.

**Prodigi (physical fulfillment) — required only to enable real orders:** a Prodigi API key and confirmation of the real SKU/spec (assumed `GLOBAL-CFP-11X14`, item cost assumed ≈ $52 + ~$10 shipping). Until then, `PRODIGI_ENABLED=false` and `MERCH_ENABLED=false` keep all commerce in the safe Mock path. The Prodigi adapter is a disabled seam and makes **no** real order or charge.

---

## 10. Remaining blockers

None for the software. The only outstanding items are **product assets you must provide**: the five approved `v1` certificate master PNGs + manifests, the physical $100K plaque artwork/vendor (manual), and — only if you want live framed orders — a Prodigi API key and confirmed SKU/pricing. Everything else is implemented, tested, and green.

---

## 11. Branch / push confirmation

All Milestone 6 work is committed on `claude/futures-trading-simulator-v8qefu` and pushed to `origin`. The working tree is clean and local `HEAD` equals `origin/claude/futures-trading-simulator-v8qefu` (see the push step accompanying this report).
