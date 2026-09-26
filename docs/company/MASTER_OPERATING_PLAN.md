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
**Status: product-model half ✅ DONE (Phase 3); Golden-Path half ✅ DONE in simulation (Phase 5).**
**Goal:** decide the one true product model and prove the Core 50K path end-to-end.
- ✅ Resolved DR-1, DR-2, DR-4, DR-6 (drawdown type + four divergences + contract-limit
  representation + canonical seed). One authoritative model in `@atlas/contracts`;
  DB ↔ catalog ↔ economics ↔ seed reconciled to a single source.
- ✅ `db:seed` produces the canonical catalog; 7 legacy templates RETIRED (not deleted);
  idempotent reconciliation for existing DBs; fresh + existing DB verified.
- ✅ **DONE (Phase 5, 2026-09-26):** the Core 50K Golden Path
  (purchase → provision → trade → pass → qualify → fund → trade → winning days → request →
  approve → dev settlement → PAID → certificate → history) now runs as a durable single
  integration harness (`golden-path.core50k.test.ts`, 15 tests) using real domain services + the
  real trading engine, all transitions exactly-once. Proven **in simulation** (settlement/identity
  dev/test, execution simulation).
- **Exit (product-model): met.** **Exit (Golden Path, simulation): met** (Phase 5). Real money
  boundaries (Phases B–E) remain the gate to a *production* Golden Path.

### Phase B — Boundary Safety: fail-close the mocks
**Status: fail-close half ✅ DONE (Phase 4, 2026-09-26); self-serve route gating (HTF-21) not yet.**
**Goal:** make "no real money" a property of the *code*, not the *config*.
- ✅ Fixed HTF-1 and HTF-2: commerce and identity providers fail closed in production via a
  central provider-safety boundary (`config/provider-safety.ts`). Resolved DR-3. Notifications
  also fail closed (suppress, never fake SENT).
- ✅ Gated `/design-lab` (HTF-4) to development builds; the development seed hard-fails in
  production.
- ✅ **DONE (Phase 7, 2026-09-26):** gated the self-serve rule/reset/environment routes to
  PRACTICE-only for commercially-weighted accounts (HTF-21) — a trader can no longer weaken the
  risk rules they are judged by, revive a breach, or turn off their own fees.
- **Exit (fail-close): met** — a misconfigured production cannot silently mock a purchase or a
  KYC check, and no fake data (Design Lab) is reachable in a prod build. **Exit (HTF-21): met**
  (Phase 7). NOTE: this phase did NOT wire real providers — that is Phases C/D/E.

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
**Status: enforcement half ✅ DONE (Phase 7 — HTF-24); console surfacing (HTF-10) still open.**
- ✅ **Phase 7:** the money/lifecycle kill switches now ENFORCE at their server chokepoints
  (`DISABLE_NEW_PURCHASES/PROVISIONING/NEW_PAYOUT_REQUESTS/PAYOUT_SUBMISSION/EXTERNAL_EXECUTION`) —
  engaging one has real effect, not just an audit event (HTF-24). Owner OS routine ops accepted as
  console-operable (`OWNER_OS_ACCEPTANCE.md`).
- ⏳ Still to do: surface the safety/config/incident/export mutations in the console UI (HTF-10 —
  the controls exist server-side and are operable via API today), add `/ready` + metrics + tracing.
- **Exit:** an operator can detect, decide, and act during an incident **from the console**. Safety
  controls now *work* when engaged; the remaining gap is the console buttons + observability.

### Phase H — Real market data (if live trading is intended)
**Status: deterministic half ✅ DONE (Phase 6, 2026-09-26); live Rithmic Test acceptance = OWNER MANUAL.**
- Decide feed (Rithmic/Databento) and wire it behind the existing fail-fast selector; prove
  freshness gating with a real feed.
- ✅ **Phase 6:** the Rithmic Test market-data + execution path is proven **deterministically** —
  framing/codec/registry (ids derived), connection state machine, heartbeat, bounded reconnect,
  discovery (`SYSTEM_ABSENT` not silent swap), market-data normalization + ms timestamps +
  freshness (open socket ≠ fresh), historical bars + no-dup/no-backward merge, order lifecycle
  (ack ≠ fill, lost-ack → `SUBMISSION_UNKNOWN`), P&L, reconciliation, bounded metrics. Provider
  selection is fail-fast with **NO fallback masking**; owner health reads truthfully
  (`UNCONFIGURED`/`NOT_VERIFIED`/`verified:false`). Evidence + the acceptance checklist:
  `RITHMIC_ATLAS_ACCEPTANCE.md`.
- ⏳ **OWNER MANUAL REQUIRED:** official R\|Protocol conformance, live auth, a live tick, and a
  live order round-trip against **Rithmic Test** — cannot run in this container (no credentials,
  by policy). Run locally with credentials; CI must not require personal credentials.
- **Exit:** the terminal runs on the intended feed with honest staleness handling. **Deterministic
  exit: met.** **Live exit: pending the owner-run Rithmic Test acceptance.**

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
