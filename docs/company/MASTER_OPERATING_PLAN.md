# MASTER OPERATING PLAN

**Happy Trader Funding — Launch Core Recovery. The authoritative, evidence-based plan.**

Baseline HEAD: `55df4c7` · Compiled 2026-09-25 (Phase 2 reconciliation).

## Purpose

This is the single plan of record for getting Happy Trader Funding from *comprehensively
built in simulation* to *safely operating with real customers and real money*. It replaces
milestone-completion optimism with the reconciled truth in the sibling documents:
`SYSTEM_STATUS.md`, `KNOWN_ISSUES.md`, `PRODUCT_SOURCE_OF_TRUTH.md`, `MONEY_FLOW.md`,
`GOLDEN_PATH.md`, `ACCOUNT_STATE_MACHINE.md`, `ARCHITECTURE_MAP.md`, `LAUNCH_GATES.md`,
`PRODUCTION_READINESS.md`, `DECISION_LOG.md`.

## Where we actually are (one paragraph)

The platform is a well-engineered futures **trading simulator** with a comprehensive
prop-firm commerce layer (Happy Trader Funding). Auth, RBAC, the trading engine, the risk
engine, payouts (economic), certificates, enforcement, affiliates, support, and the Owner OS
are all BUILT and server-authoritative, with strong idempotency and an append-only hash-chained
audit log. The entire Golden Path runs end-to-end **in simulation**. It is **not** connected
to real money: payment-in is Whop sandbox-only (and the mock fails open), KYC is a fabricating
mock (fails open), and there is no real payout rail. The runtime product model (DB) disagrees
with the public site on four properties, and the default seed produces the wrong catalog.
There is no CI, no backups, and no production deploy path.

## Guiding principle

**Truth before features.** We do not build new product on top of an unreconciled base. Each
phase below has an explicit exit condition that is *proven*, not *claimed*.

---

## Phases

Phases are ordered by dependency, not by appeal. Phase 2 (this reconciliation) is complete;
Phase A is the recommended next mission.

### Phase A — Authoritative Product Model + Core 50K Golden Path
**Status: product-model half ✅ DONE (Phase 3, 2026-09-26); Golden-Path half not yet run.**
**Goal:** decide the one true product model and prove the Core 50K path end-to-end.
- ✅ Resolved DR-1, DR-2, DR-4, DR-6 (drawdown type + four divergences + contract-limit
  representation + canonical seed). One authoritative model in `@atlas/contracts`;
  DB ↔ catalog ↔ economics ↔ seed reconciled to a single source.
- ✅ `db:seed` produces the canonical catalog; 7 legacy templates RETIRED (not deleted);
  idempotent reconciliation for existing DBs; fresh + existing DB verified.
- ⏳ **Still to do (a later, explicitly-authorized phase):** run the Core 50K Golden Path
  (purchase → provision → trade → pass → qualify → fund → trade → winning days → request →
  approve → PAID → certificate → history) as a single live integration test. Phase 3 proved
  the *product values* are consistent across catalog/DB/commerce/provisioning/portal/risk/
  payouts/economics, but did NOT run the full lifecycle end-to-end.
- **Exit (product-model): met** — one authoritative model, all sources agree, verified in a
  real browser (Owner Products + Portal). **Exit (Golden Path): pending.**

### Phase B — Boundary Safety: fail-close the mocks
**Goal:** make "no real money" a property of the *code*, not the *config*.
- Fix HTF-1 and HTF-2: fail closed in production for commerce and identity providers (mirror
  the payout registry). Resolve DR-3.
- Gate `/design-lab` (HTF-4) and the self-serve rule/reset/environment routes for
  commercially-weighted accounts (HTF-21).
- **Exit:** a misconfigured production cannot silently mock a purchase or a KYC check; no fake
  data reachable in a prod build.

### Phase C — Real payments in (Whop production)
- Resolve DR-5 (payments portion). Wire Whop production behind the now-fail-closed selector;
  prove the signature-verified webhook → provisioning path with a real (test-mode) charge.
- **Exit:** a real charge provisions exactly one account, idempotently, with audit + reconciliation.

### Phase D — Real KYC (Stripe Identity)
- Wire Stripe Identity; prove the provisioning gate blocks on real not-verified/needs-review.
- **Exit:** no account provisions without a real identity decision; compliance gate proven.

### Phase E — Real payouts out
- Build/select a real payout provider; wire the operational pipeline's submit/reconcile to it;
  prove APPROVED → submitted → real PAID → reconciled with lost-ack recovery.
- Fix HTF-9 (affiliate ledger idempotency) with a constraint + concurrency test.
- **Exit:** a real disbursement happens exactly once and reconciles; no double-debit under concurrency.

### Phase F — Operate it: CI, deploy, backups, cron
- Stand up CI (build/typecheck/test on every change). Add production deploy manifests. Add DB
  backups/PITR. Bind the inactivity cron (HTF-18).
- **Exit:** the system can be deployed, rolled back, restored, and its jobs run on schedule.

### Phase G — Observability + operability
- Surface Owner-OS safety mutations (kill switches first, HTF-10). Add `/ready` + metrics +
  tracing. Make alerts/incidents actionable in the console.
- **Exit:** an operator can detect, decide, and act during an incident from the console.

### Phase H — Real market data (if live trading is intended)
- Decide feed (Rithmic/Databento) and wire it behind the existing fail-fast selector; prove
  freshness gating with a real feed.
- **Exit:** the terminal runs on the intended feed with honest staleness handling.

### Phase I — Legal + disclosures alignment
- With the product model settled (Phase A), align agreements/disclosures to the enforced rules;
  legal sign-off. Never marked VERIFIED from code.
- **Exit:** what a customer signs matches what the engine enforces.

### Phase J — Notifications (email/SMS)
- Wire Resend/Twilio; prove delivery; keep the suppress-not-fake behavior for failures.

### Phase K — Physical fulfillment (if merch launches)
- Wire Prodigi behind its disabled seam; prove preflight + fulfillment.

### Phase L — Economics consolidation
- Resolve DR-9 (retire v1 or keep both); ensure economics derives from the authoritative model.

### Phase M — Scale + resilience
- Load/torture the reconciled system; validate the outbox/projection/reconciliation under
  scale and failure injection (harnesses already exist).

### Phase N — Production pilot
- Limited real-customer pilot on the canonical Core products with all boundaries wired and
  proven; watch the gates; iterate.

---

## Sequencing rationale

- **A before everything:** you cannot sell, disclose, or model a product you have not defined.
  It is also the cheapest phase (mostly decisions + reconciliation, little new code).
- **B before C/D/E:** fail-close first so that wiring real providers can never regress to a
  silent mock.
- **C/D/E are the money boundaries** — the actual product promise. They are the highest-risk
  and are gated behind A+B deliberately.
- **F/G are operability** — needed to run any of the above safely in production; can proceed in
  parallel with C/D/E once A/B are done.
- **H–N** are conditional/parallel depending on business priorities.

## What this plan explicitly does NOT do

Per the Phase 2 mandate, this plan is the *baseline*, not the execution. It does not begin
fixing the product, does not implement Core 50K, does not stabilize Atlas further, does not
touch the website, and does not deploy. Those are the phases above, to be started as separate,
explicitly-authorized missions.

## PROVENANCE

Built entirely from the reconciled findings in this `docs/company/` set, which in turn come
from six parallel read-only code audits + a live local stack boot + direct DB inspection, with
money/trust-critical claims verified personally. No product decision was made here; all forks
are logged as DECISION REQUIRED in `DECISION_LOG.md`.
