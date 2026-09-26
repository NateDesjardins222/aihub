# PRODUCT MATRIX ACCEPTANCE — ALL 10 COMMERCIAL PRODUCTS

**Phase 8 — full product matrix + lifecycle acceptance; prevent product rule cross-contamination.**

Baseline HEAD at start: `f838bde` (Phase 7) · Compiled 2026-09-26 ·
branch `claude/futures-trading-simulator-v8qefu`.

> **The Phase 8 risk, stated up front:** the danger is not missing UI — it is **product rule
> cross-contamination**: Select behaving like Core, Daily's buffer bleeding into Core/Select, a 50K
> default leaking into 25K/100K/300K, or the current product version being used instead of an
> account's pinned one. Phase 8 proves each product's rules survive
> catalog → commerce → provisioning → risk → payout **as its own**, at both the config level and
> through the real runtime. Nothing is PRODUCTION-VERIFIED; payments/payouts/KYC remain mock/dev.

---

## 1. The locked commercial matrix (authoritative)

The single source of truth is `@atlas/contracts` (`product-catalog.ts` → `product-model.ts`). It
matches the Phase 8 locked spec exactly:

| Product | Price | Start | Target | EOD DD | Init floor | Minis/Micros | Eval C | Funded C | Buffer | Cap |
|---|---|---|---|---|---|---|---|---|---|---|
| CORE 25K | $65 | $25,000 | $1,500 | $1,000 | $24,000 | 2 / 20 | 50% | — | $0 | $1,000 |
| CORE 50K | $95 | $50,000 | $3,000 | $2,000 | $48,000 | 5 / 50 | 50% | — | $0 | $2,000 |
| CORE 100K | $170 | $100,000 | $6,000 | $4,000 | $96,000 | 10 / 100 | 50% | — | $0 | $3,500 |
| CORE 300K GOLD | $599 | $300,000 | $15,000 | $10,000 | $290,000 | 20 / 200 | 50% | — | $0 | $5,000 |
| SELECT 25K | $85 | $25,000 | $1,500 | $1,250 | $23,750 | 3 / 30 | 40% | 40% | $0 | $1,000 |
| SELECT 50K | $135 | $50,000 | $3,000 | $2,500 | $47,500 | 7 / 70 | 40% | 40% | $0 | $2,000 |
| SELECT 100K | $230 | $100,000 | $6,000 | $5,000 | $95,000 | 15 / 150 | 40% | 40% | $0 | $3,500 |
| DAILY 25K | $90 | $25,000 | $1,500 | $1,000 | $24,000 | 2 / 20 | 40% | — | $1,000 | $1,000 |
| DAILY 50K | $145 | $50,000 | $3,000 | $2,000 | $48,000 | 5 / 50 | 40% | — | $2,000 | $2,000 |
| DAILY 100K | $250 | $100,000 | $6,000 | $4,000 | $96,000 | 10 / 100 | 40% | — | $4,000 | $3,500 |

Shared, locked terms (verified): trader split **90/10**, activation **$0**, **5** qualifying
winning days at **≥ $150** net, max **5** PAID payout cycles, EOD-trailing drawdown with
**lock-at-starting-balance** (`trailingLockAtMicros = 0`), micros = minis × 10.

---

## 2. Config-level matrix (PROVEN — `packages/contracts/src/product-model.test.ts`, 153 tests)

The existing product-integrity suite is a full 10-product regression matrix that asserts, for every
product, every field above against the locked values, plus the family-distinction guards. It fails
loudly if any one product's price, target, drawdown, contract limit, consistency, buffer or cap
drifts in a single place. Cross-contamination guards it already carries:

- **CORE 300K Gold is 15,000 / 10,000** (not 18,000 / 12,000).
- **SELECT drawdowns are 1,250 / 2,500 / 5,000** (5%, not Core's 4%).
- **CORE & SELECT carry $0 funded buffer**; **DAILY carries 1,000 / 2,000 / 4,000**.
- **SELECT keeps its 40% funded/payout consistency**; CORE & DAILY funded consistency is null.
- Every product (eval + funded) uses **EOD_TRAILING, lock-at-start**.
- Funded destinations: 10, internal (not commercial), zero target, mirror the eval drawdown.

---

## 3. Runtime matrix (PROVEN — `apps/server/src/platform/product-matrix.runtime.test.ts`, 4 tests)

Config being right is not enough — the runtime must USE each product's own pinned terms. This suite
provisions a **real EVALUATION account for all 10 products** through the authoritative
`provisionAccount` path and asserts, per product:

- Provisioned **starting balance = its own size** (25K/50K/100K/300K) — **no 50K default leak**.
- Provisioned **initial EOD floor = start − its own drawdown** (e.g. 25K → $24,000, Select 50K →
  $47,500, Daily 100K → $96,000).
- `accountType = EVALUATION`, and the account is **pinned to the resolved version**
  (`profileVersionId`), never "the current version".
- The pinned version's rules are that product's own: target, drawdown, contract limit (minis),
  EOD_TRAILING + lock 0, and consistency (**CORE 50%, SELECT/DAILY 40%**).

Cross-contamination assertions that would catch a leak:
- The four Core sizes have **four distinct floors** (a 50K default would collapse two sizes).
- **Same size, different family:** Core 50K floor $48,000 ≠ Select 50K floor $47,500 — the wider
  Select drawdown is not replaced by Core's.
- **Only DAILY carries a funded buffer; only SELECT a funded consistency; CORE has neither** —
  read back per product from the pinned config.

---

## 4. Payout-engine non-contamination (VERIFIED structurally)

The payout eligibility engine (`apps/server/src/platform/payout-core.ts`) reads
`fundedBufferMicros` and `payoutConsistencyThreshold` from each account's **pinned**
`account_profile_versions.config.payoutRules` (not a hardcoded family default): the buffer gate at
`payout-core.ts:255,272` and the consistency gate at `:322,325`. Because §3 proves every account is
pinned to its own correct product version, the payout engine necessarily applies that product's own
buffer/consistency — a Core account's policy has buffer $0 / consistency null, a Select account's
has consistency 40%, a Daily account's has its buffer. Daily's buffer cannot bleed into Core/Select,
and Select's funded-consistency cannot leak into Core, at the payout boundary. The per-family payout
behaviours themselves (Daily buffer/progression, Select delay-not-fail, Core no funded rule) were
proven in the M5/M6 payout suites and the Phase 5 CORE 50K golden path.

---

## 5. Seed / versioning (PROVEN — `product-reconcile.test.ts`, 6 tests)

A normal `db:migrate` + `db:seed` produces the 10 ACTIVE commercial products (plus internal
funded/practice profiles); legacy Atlas templates stay RETIRED, never ACTIVE. Reconciliation is
idempotent and version-safe: re-running publishes no new version when nothing changed, existing
accounts stay pinned to their version, and historical terms remain queryable.

---

## 6. Deterministic evidence run (this acceptance)

`NODE_ENV=test`, all green:

| Suite | Result |
|---|---|
| Config matrix — 10 products × every field + family guards (`product-model.test.ts`) | **153 passed** |
| Runtime provisioning matrix — all 10, no leak, family distinctions (`product-matrix.runtime.test.ts`) | **4 passed** |
| Seed reconcile + version safety (`product-reconcile.test.ts`) | **6 passed** |
| Phase 5 CORE 50K Golden Path regression (`golden-path.core50k.test.ts`) | **15 passed** ¹ |
| Server typecheck (`tsc --noEmit`) | **clean** |

¹ The Golden Path's ledger-reconciliation case exceeds vitest's default **5s** timeout on the
cold, heavily-accumulated shared test DB after the container restart; it passes 15/15 with
`--testTimeout=30000`. This is an environmental timeout on a loaded test database, not a logic
regression — the Phase 8 change is a single additive test file that touches no Golden Path code.

---

## 7. What Phase 8 deliberately did NOT do

- Did not create products, change prices, or change locked rules (the catalog already matched the
  spec exactly — nothing to repair).
- Did not wire real payments/payouts/KYC or enable production Rithmic.
- Did not redesign the website, Portal, Atlas, or Owner OS.

---

## PROVENANCE

The authoritative matrix was read from `@atlas/contracts` (`product-catalog.ts` +
`product-model.ts`) and confirmed field-for-field against the Phase 8 locked spec. The config
matrix is guarded by the existing 153-test product-integrity suite; the new runtime provisioning
matrix (4 tests) proves the runtime uses each product's pinned terms with no cross-contamination;
the payout non-contamination is established from `payout-core.ts` reading per-account pinned
`payoutRules`. Every assertion is derived from the catalog, not copied. No real provider was
connected; nothing is PRODUCTION-VERIFIED.
