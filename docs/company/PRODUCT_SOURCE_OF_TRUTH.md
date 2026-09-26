# PRODUCT SOURCE-OF-TRUTH MATRIX

**Phase 2 — System-Wide Reconciliation. Audit-only. No product rule was changed by this document.**

Baseline HEAD: `55df4c7` · Branch: `claude/futures-trading-simulator-v8qefu` · Compiled 2026-09-25.

---

## ⟳ PHASE 3 UPDATE — the divergences below are now RESOLVED (2026-09-26)

Phase 3 (Authoritative Product Model + Seed Reconciliation) established **one**
authoritative source and reconciled every source to it. The four disagreements this
document surfaced are closed:

- **One authoritative model:** `packages/contracts/src/product-model.ts` builds every
  product from the shared catalog (`product-catalog.ts`). The DB seed, the reconciliation,
  and the economics engine all consume it. There is no second catalog.
- **D-1 (drawdown type):** all 10 HTF products are now **EOD_TRAILING** in the DB (was
  STATIC). Resolved to the public-site/catalog value.
- **D-2 / D-3 (CORE 300K Gold):** target **$15,000**, drawdown **$10,000** (was
  $18,000 / $12,000). Resolved to the catalog value.
- **D-4 (SELECT drawdowns):** **$1,250 / $2,500 / $5,000** (5%; was 4%). Resolved to the
  catalog value.
- **Contract limits:** represented as **minis** (`maxContracts`) with
  `microsCountAsFraction=true`, where 10 micros = 1 mini (existing `@atlas/instruments`
  `contractWeight`). Every catalog account satisfies `micros = 10 × minis`, enforced by an
  invariant test.
- **Seed:** the normal `pnpm db:seed` now produces exactly the 10 commercial evaluations
  (ACTIVE) + 10 funded destinations (INTERNAL) + one practice profile (INTERNAL); the 7
  legacy Atlas templates are RETIRED, never deleted. No manual second seed step.

Verified against the live DB (fresh + reconciled), the Owner Products console, and the
Customer Portal. The historical matrix below is retained as the Phase-2 record of what the
divergence WAS. Runtime authority is now the DB, which equals the catalog for every field.
See `DECISION_LOG.md` (DR-1, DR-2, DR-4, DR-6 → RESOLVED).

---

## ⟳ PHASE 3.5 UPDATE — funded-risk + payout semantics LOCKED (2026-09-26)

Phase 3.5 closed the risk-semantics questions Phase 3 had flagged but not decided, changing
**config values only** — no product was redesigned, no model rebuilt:

- **EOD-trailing lock point:** the trailing drawdown floor now **locks at the starting balance**
  once the high-water mark has risen by the full drawdown amount
  (`EVAL_TRAILING_LOCK_AT_MICROS = 0`, applied to every eval + funded profile). It ratchets
  **only** at the finalized EOD roll (off the closing balance) and never moves backward. The
  engine already implemented this; only the product-config value changed (`null` → `0`).
- **Breach metric:** authoritative breach is on **equity** vs the current floor, enforced
  intraday; the floor itself never ratchets from intraday unrealized gains.
- **Funded buffers:** CORE and SELECT carry **$0** initial funded buffer; SELECT's protection
  is its **40% payout consistency** (which *delays* a payout, not fails the account). DAILY
  keeps its progressive buffers ($1,000 / $2,000 / $4,000).
- **Post-payout floor:** a payout never resets or loosens the floor; withdrawable is realized
  profit above the protected balance only, so it cannot breach the floor.

Reconciliation published these as **new immutable versions (v2)** per profile; accounts pinned
to v1 keep their v1 terms (version-safe). Locked with deterministic tests
(`packages/core/src/rules/eod-trailing-lock.test.ts`, plus product-integrity and payout-core
suites). See `DECISION_LOG.md` DR-11 → RESOLVED and `ACCOUNT_STATE_MACHINE.md` for the engine
detail.

---

## What this document is

Every place in the system that "knows" what a product is, traced side by side, so
that where two places disagree, the disagreement is written down rather than silently
reconciled. Per the Phase 2 mandate, **disputed product rules are NOT decided here.**
They are surfaced for an explicit owner decision (see `DECISION_LOG.md`).

## The four places a product is defined

| # | Source | Kind | Role | File / location |
|---|--------|------|------|-----------------|
| 1 | **DB `account_profiles` + `account_profile_versions`** | Runtime authority | What the running product actually is at checkout / provisioning / evaluation | tables; loaded by `apps/server/src/platform/profiles.ts` `resolveProfileByKey` |
| 2 | **Shared code catalog `@atlas/contracts/product-catalog.ts`** | Code default / fallback | Typed single source for web + server code; economics engine derives from it | `packages/contracts/src/product-catalog.ts` |
| 3 | **Web marketing catalog `apps/web/src/marketing/catalog.ts`** | Public site display | What a prospective customer is shown | re-exports #2 verbatim (`export { FAMILIES, ALL_ACCOUNTS, ... } from '@atlas/contracts'`) |
| 4 | **DB seed `scripts/seed-htf-products.ts`** | Seeder | Writes the HTF products into #1 | `apps/server/scripts/seed-htf-products.ts` |

**Key structural fact:** #3 (web marketing) is a pure re-export of #2 (shared catalog),
so the public site and the code catalog **cannot diverge** — they are literally the same
numbers. The divergences below are therefore all **DB (runtime authority) vs shared
catalog / public site**.

The shared catalog's own header already documents the headline divergence (verbatim):

> KNOWN DIVERGENCE (reported, not silently reconciled — product rules are an owner
> decision): the drawdown model here is EOD trailing (`eodDrawdownUsd`), matching the
> public site, whereas the current DB seed `evalRules` computes a STATIC drawdown at 4%
> of size for every family.

This audit confirms that note is accurate, and adds three further numeric divergences the
note does not mention (300K target, 300K drawdown amount, SELECT drawdown amounts).

## How the ground-truth DB column was obtained

The DB values below are not read from a seed file — they were queried directly from the
live local Postgres cluster (`account_profile_versions.config` jsonb, latest version per
profile) after a full stack boot with both seeds applied. Money is stored in integer
micro-dollars ($1 = 1,000,000 micros) and is shown here in dollars.

---

## MATRIX A — The intended 10 commercial products (HTF)

Legend for each cell: **DB** = live runtime authority; **CAT** = shared catalog / public
site. When only one value is shown, both agree. **⚠ = disagreement.**

### CORE family

| Property | 25K | 50K | 100K | 300K (Gold) |
|----------|-----|-----|------|-------------|
| Profile key | htf-core-25k | htf-core-50k | htf-core-100k | htf-core-300k |
| Price | $65 | $95 | $170 | $599 |
| **Profit target** | $1,500 | $3,000 | $6,000 | **⚠ DB $18,000 / CAT $15,000** |
| **Drawdown amount** | $1,000 | $2,000 | $4,000 | **⚠ DB $12,000 / CAT $10,000** |
| **Drawdown type** | **⚠ DB STATIC / CAT EOD_TRAILING** | ⚠ DB STATIC / CAT EOD_TRAILING | ⚠ DB STATIC / CAT EOD_TRAILING | ⚠ DB STATIC / CAT EOD_TRAILING |
| Eval consistency | 50% | 50% | 50% | 50% |
| Funded/payout consistency | none | none | none | none |
| Contract limit | DB maxContracts 10 / CAT 2 minis · 20 micros | DB 20 / CAT 5 · 50 | DB 40 / CAT 10 · 100 | DB 100 / CAT 20 · 200 |
| Winning days | 5 | 5 | 5 | 5 |
| Winning-day threshold | $150 | $150 | $150 | $150 |
| Payout request cap | $1,000 | $2,000 | $3,500 | $5,000 |
| Min payout request | $250 | $250 | $250 | $250 |
| Profit split | 90% | 90% | 90% | 90% |
| Activation fee | $0 | $0 | $0 | $0 |
| Buffer | $0 | $0 | $0 | $0 |
| Max payout cycles | 5 | 5 | 5 | 5 |
| Funded destination | htf-core-25k-funded | htf-core-50k-funded | htf-core-100k-funded | htf-core-300k-funded |

### SELECT family

| Property | 25K | 50K | 100K |
|----------|-----|-----|------|
| Profile key | htf-select-25k | htf-select-50k | htf-select-100k |
| Price | $85 | $135 | $230 |
| Profit target | $1,500 | $3,000 | $6,000 |
| **Drawdown amount** | **⚠ DB $1,000 (4%) / CAT $1,250 (5%)** | **⚠ DB $2,000 (4%) / CAT $2,500 (5%)** | **⚠ DB $4,000 (4%) / CAT $5,000 (5%)** |
| **Drawdown type** | ⚠ DB STATIC / CAT EOD_TRAILING | ⚠ DB STATIC / CAT EOD_TRAILING | ⚠ DB STATIC / CAT EOD_TRAILING |
| Eval consistency | 40% | 40% | 40% |
| Funded/payout consistency | 40% | 40% | 40% |
| Contract limit | DB 10 / CAT 3 · 30 | DB 20 / CAT 7 · 70 | DB 40 / CAT 15 · 150 |
| Winning days | 5 | 5 | 5 |
| Payout request cap | $1,000 | $2,000 | $3,500 |
| Profit split | 90% | 90% | 90% |
| Activation fee | $0 | $0 | $0 |
| Buffer | $0 | $0 | $0 |
| Max payout cycles | 5 | 5 | 5 |
| Funded destination | htf-select-25k-funded | htf-select-50k-funded | htf-select-100k-funded |

*SELECT payout-consistency semantics (from `payout-core.ts`): exceeding consistency
**delays** a payout, it does not fail the account. This is a code behaviour, not a per-size
value, and DB + catalog agree on the 40% figure.*

### DAILY family

| Property | 25K | 50K | 100K |
|----------|-----|-----|------|
| Profile key | htf-daily-25k | htf-daily-50k | htf-daily-100k |
| Price | $90 | $145 | $250 |
| Profit target | $1,500 | $3,000 | $6,000 |
| Drawdown amount | $1,000 | $2,000 | $4,000 |
| **Drawdown type** | ⚠ DB STATIC / CAT EOD_TRAILING | ⚠ DB STATIC / CAT EOD_TRAILING | ⚠ DB STATIC / CAT EOD_TRAILING |
| Eval consistency | 40% | 40% | 40% |
| Funded/payout consistency | none | none | none |
| Contract limit | DB 10 / CAT 2 · 20 | DB 20 / CAT 5 · 50 | DB 40 / CAT 10 · 100 |
| Winning days | 5 | 5 | 5 |
| **Buffer** | $1,000 | $2,000 | $4,000 |
| Payout request cap | $1,000 | $2,000 | $3,500 |
| Profit split | 90% | 90% | 90% |
| Activation fee | $0 | $0 | $0 |
| Max payout cycles | 5 | 5 | 5 |
| Funded destination | htf-daily-25k-funded | htf-daily-50k-funded | htf-daily-100k-funded |

*DAILY progressive-balance rule (from `payout-core.ts`): each successive Daily payout
requires the balance to have grown to a strictly higher threshold than the prior approved
Daily payout (`DAILY_BALANCE_PROGRESSION_NOT_MET`). Buffer must be cleared before daily
payout eligibility. DB + catalog agree on the buffer amounts above.*

---

## THE CONFIRMED DISAGREEMENTS (do not resolve in Phase 2)

Exactly four numeric/type divergences exist between the runtime authority (DB) and the
public site / shared catalog. **All four are DB-vs-catalog; the public site equals the
catalog.**

| # | Property | Runtime DB authority | Public site / catalog | Scope | Notes |
|---|----------|----------------------|------------------------|-------|-------|
| **D-1** | Evaluation drawdown **type** | `STATIC` (fixed % of size) | `EOD_TRAILING` | **All 10 HTF products** | The seed hard-codes `drawdownType: 'STATIC'` (`seed-htf-products.ts:86`); the public site advertises end-of-day trailing. These are materially different risk mechanics for the customer. |
| **D-2** | CORE 300K **profit target** | $18,000 | $15,000 | htf-core-300k only | 6% vs 5% of size. |
| **D-3** | CORE 300K **drawdown amount** | $12,000 | $10,000 | htf-core-300k only | 4% (DB) vs 3.33% (catalog). |
| **D-4** | SELECT **drawdown amount** | $1,000 / $2,000 / $4,000 (4% of size) | $1,250 / $2,500 / $5,000 (5% of size) | htf-select-25k/50k/100k | The public site markets SELECT as "room to breathe" (a *wider* drawdown); the DB gives SELECT the *same* 4% drawdown as CORE, which contradicts the marketing differentiator. |

### What AGREES across every source (no disagreement)

Price · profit split (90%) · activation fee ($0) · winning days (5) · winning-day
threshold ($150) · minimum payout request ($250) · payout request caps by size
($1,000 / $2,000 / $3,500 / $5,000) · max payout cycles (5) · evaluation consistency
(CORE 50%, SELECT/DAILY 40%) · SELECT payout consistency (40%) · DAILY buffers
($1,000 / $2,000 / $4,000) · CORE/SELECT/DAILY 25K/50K/100K profit targets · CORE/DAILY
25K/50K/100K drawdown amounts.

### Representation difference (not strictly a disagreement)

**Contract limits are represented differently, not just valued differently.** The DB
stores a single `maxContracts` integer per product (e.g. CORE 50K = 20). The catalog
stores a **minis + micros** pair (e.g. CORE 50K = 5 minis, 50 micros). There is no single
DB field that maps cleanly onto the minis/micros pair, so the two cannot be directly
equated without a stated conversion rule. The engine enforces `maxContracts` (weighted,
increasing-exposure only — see `ARCHITECTURE_MAP.md` Area G); the minis/micros pair is a
display/marketing construct. **This needs an owner-stated conversion rule** (does 1 mini
count as N micros for the DB cap?) before the two can be called "consistent."

---

## MATRIX B — The 10 funded destinations (provisioned on funding approval)

Each HTF evaluation names a `fundedDestinationKey`; on funding approval the trader is
provisioned an account under the matching `*-funded` profile. Verified from the DB:

- All ten `htf-*-funded` profiles exist (core/select/daily × 25k/50k/100k + core-300k-funded).
- **Profit target = $0** on every funded destination (funded accounts have no evaluation
  target — expected and correct, not a defect).
- Drawdown amount and `maxContracts` mirror the paired evaluation (e.g. htf-core-50k-funded:
  maxLoss $2,000, maxContracts 20), drawdownType STATIC.

---

## MATRIX C — Legacy / stale Atlas templates present in the DB (NOT part of the intended line-up)

The DB also contains **7 legacy Atlas evaluation templates** left over from the pre-HTF
product model. They are seeded by `apps/server/src/db/seed.ts` (the original Atlas seed),
have **no price** and **no `payoutRules`**, use generic names and wrong sizes (50/100/150K),
and are **not** part of the CORE/SELECT/DAILY commercial catalog. They are shown here for
completeness because they appear in the Owner Console Products list alongside the intended
products (27 profiles total = 10 HTF + 10 funded + 7 legacy).

| Key | Size | Target | Max loss | Drawdown type | Max contracts | Price | Payout rules | Verdict |
|-----|------|--------|----------|---------------|---------------|-------|--------------|---------|
| evaluation-50k | 50K | $3,000 (6%) | $2,000 (4%) | EOD_TRAILING | 5 | — | — | STALE-LEGACY |
| evaluation-100k | 100K | $6,000 (6%) | $3,000 (3%) | EOD_TRAILING | 10 | — | — | STALE-LEGACY |
| evaluation-150k | 150K | $9,000 (6%) | $4,500 (3%) | EOD_TRAILING | 15 | — | — | STALE-LEGACY |
| intraday-trailing-50k | 50K | $3,000 | $2,000 | INTRADAY_TRAILING | 5 | — | — | STALE-LEGACY |
| static-100k | 100K | $6,000 | $3,000 | STATIC | 10 | — | — | STALE-LEGACY |
| practice-100k | 100K | $1,000,000 | $100,000 | STATIC | 50 | — | — | DEV/PRACTICE fixture (absurd target) |
| practice-150k | 150K | $1,000,000 | $150,000 | STATIC | 50 | — | — | DEV/PRACTICE fixture (absurd target) |

**Observation, not an instruction:** these legacy templates are the *only* products in the
DB that use `EOD_TRAILING` — i.e. the drawdown model the public site advertises for the HTF
products lives in the DB only on the stale templates, never on the 10 real products. This
is the concrete shape of disagreement D-1.

**Not resolved here.** Whether to RETIRE the 7 legacy templates (`setProfileStatus RETIRED`)
is an owner decision recorded in `DECISION_LOG.md`. Retiring is non-destructive (status
flag; profiles are immutable and versioned), but it changes what the Products page and any
key-based resolver can pick, so it is out of scope for an audit phase.

---

## AUTHORITY / PRECEDENCE (as the code actually behaves today)

1. **At checkout and provisioning**, products are resolved **by key from the DB**
   (`resolveProfileByKey`, newest ACTIVE version). → **The DB is the runtime authority.**
   Whatever the DB says (STATIC drawdown, $18,000 300K target, 4% SELECT drawdown) is what
   a real customer actually gets.
2. **The public marketing site** shows the **catalog** values (EOD_TRAILING, $15,000 300K
   target, 5% SELECT drawdown). → **A customer is shown catalog values but provisioned DB
   values.** For the four divergences above, the site advertises one thing and the account
   enforces another.
3. **The economics engine (M13)** derives its authoritative product inputs from the shared
   catalog (`@atlas/contracts`), i.e. from the *catalog* numbers, not the DB numbers. → The
   economics model is computed against catalog values, so for the 300K and SELECT products
   the modeled economics use different targets/drawdowns than the DB would enforce. (The
   engine explicitly treats evaluation pass/fail as an assumption and does not depend on the
   drawdown mechanic, so D-1 does not change modeled cash flows; D-2/D-3/D-4 shift only the
   inputs, and only for those products.)

This precedence mismatch — **customer sees catalog, customer gets DB, economics models
catalog** — is itself the reason a single authoritative product model is the recommended
next mission. See the final report and `DECISION_LOG.md`.

---

## PROVENANCE

- DB values: direct `psql` query of `account_profile_versions.config` on the live local
  cluster, latest version per profile, both seeds applied.
- Catalog values: read verbatim from `packages/contracts/src/product-catalog.ts` (lines
  70–188).
- Web = catalog: confirmed by reading `apps/web/src/marketing/catalog.ts` (pure re-export).
- Seed writes STATIC 4%: confirmed at `apps/server/scripts/seed-htf-products.ts:85-86,105`.
- No product value was modified during this audit.
