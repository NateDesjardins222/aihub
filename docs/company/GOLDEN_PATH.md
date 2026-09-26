# GOLDEN PATH DEPENDENCY MAP

**Phase 2 — System-Wide Reconciliation. Audit-only. Nothing on this path was implemented or
changed.**

Baseline HEAD: `55df4c7` · Compiled 2026-09-25.

## ⟳ PHASE 5 UPDATE — CORE 50K Golden Path PROVEN end-to-end in simulation (2026-09-26)

The full customer lifecycle for **CORE 50K** (`htf-core-50k`) is now proven by a durable
integration harness (`apps/server/src/platform/golden-path.core50k.test.ts`, 15 tests) that
drives the REAL domain services (no direct status writes, no fabricated money events) and the
REAL trading engine, plus an ownership/cap suite (`golden-path.security.test.ts`, 2 tests).
Evidence from one run (every value below is asserted, not narrated):

- **Customer/identity:** unverified → dev/test mock provider → `IDENTITY_VERIFIED`; provisioning
  gate satisfied. Production identity stays fail-closed (Phase 4).
- **Purchase → trusted payment → provisioning:** $95 order → server-signed mock event →
  exactly **one** EVALUATION account, start $50,000, floor $48,000, pinned version; replay of the
  same event does not duplicate.
- **Real trade:** market BUY 1 NQ @ 20000 → SELL @ 20160 through the engine → realized **+$3,200**,
  commission **$5.38** posted, balance = start + realized − fees ($53,194.62) — invariant holds.
- **Risk (EOD trailing, rule engine):** intraday unrealized does not ratchet; finalized closes
  51k→floor 49k, 52k→floor 50k (locked at start), higher HWM stays 50k, losing day never backward;
  breach enforced intraday on **equity**.
- **Consistency:** target reached with best-day/total > 50% → GOAL_REACHED (delayed, not failed);
  ≤ 50% → PASSED.
- **Evaluation pass → funded:** `certifyEvaluation` (real rules) → PASSED + ELIGIBLE qualification;
  `approveFunding` → exactly **one** FUNDED_SIM account, lineage to the evaluation; both idempotent.
- **Certificates:** FUNDED_TRADER + PAYOUT certificates issued once each, publicly verifiable.
- **Winning days:** counting rules proven (≥$150 counts, <$150 and negative do not); 5 qualifying
  days recorded via the authoritative day-close writer.
- **Payout:** eligibility ELIGIBLE (5 winning days, $1,000 withdrawable); request $500 → approve →
  trader **$450** / firm **$50** / account debit **$500** (exact 90/10); **single** DEBIT ledger row
  (retry does not double-debit); floor unchanged by payout.
- **Settlement:** dev/test bookkeeping only — PAID once, SETTLEMENT ledger `meta.mock=true`
  (never a real external payout); idempotent.
- **Reconciliation/invariants:** `auditLedgers` clean for the accounts; one order → one eval → one
  funded → one PAID → one funded cert → one payout cert; 5-active cap enforced (6th refused);
  cross-customer account reads refused (ACCOUNT_NOT_FOUND).

The arrow table below is retained as the Phase-2 record. Where it says STATIC drawdown (arrow 5),
that is superseded: the enforced rule is **EOD_TRAILING with lock-at-start** (Phase 3.5). No step is
PRODUCTION-VERIFIED; settlement/identity remain dev/test only.

## The path

The single end-to-end journey the business depends on:

```
Customer → Purchase (evaluation) → Provision eval account → Trade → Pass rules
        → Qualify → Fund → Trade funded → Earn winning days → Request payout
        → Approve payout → PAID → Payout certificate → Permanent history
```

## Arrow-by-arrow status

Legend: WORKING / PARTIAL / BROKEN / DISCONNECTED / MOCKED / DEV-ONLY / NOT-TESTED / UNKNOWN.
"WORKING" here means the wiring is present and server-authoritative; it does **not** mean
production-verified (no step on this path is PRODUCTION-VERIFIED).

| # | Arrow | Status | Evidence / caveat |
|---|-------|--------|-------------------|
| 1 | Customer → Purchase | **MOCKED** (sandbox/mock) | Checkout resolves an EVALUATION product and opens a Whop **sandbox** session, or the deterministic mock. Real Whop prod is a deliberate later change. **Phase 4:** `commerceProviderFromEnv` now FAILS CLOSED in production (no mock; ~~HTF-1~~) via `config/provider-safety.ts` — a misconfigured prod cannot fake a purchase. Mock is development/test only. |
| 2 | Purchase → payment confirmed | **MOCKED** | Confirmation arrives only via a **signature-verified server-side webhook** (`commerce_events` dedup); the browser success screen never grants anything. Mock self-signs its own events. |
| 3 | Payment → Provision eval account | **WORKING (gated)** | `fulfillPurchaseGated` requires identity + contact + agreements OK. Money-success recorded before provisioning → paid-but-unprovisioned parks recoverably. Multi-layer idempotency. **KYC gate depends on identity provider, which fails open to a fabricating mock (HTF-2).** |
| 4 | Provision → Trade (eval) | **WORKING (simulation, dev feed)** | Terminal is server-authoritative; execution is SIMULATION-only; default market data is `yahoo-delayed` (~600s). Risk gate blocks entry on stale feed. **Phase 6:** the Rithmic Test market-data + execution path is proven deterministically (no fallback masking; honest `NOT_VERIFIED`); the live Rithmic Test feed/order round-trip is OWNER MANUAL — see `RITHMIC_ATLAS_ACCEPTANCE.md`. |
| 5 | Trade → Pass rules | **WORKING** | Rules engine (`@atlas/core`) evaluates target/consistency/winning-days/drawdown/contract-limits under the account lock; ACTIVE→PASSED is a real, audited transition. **Which drawdown rule actually applies is the DB value (STATIC), not the advertised one (EOD_TRAILING) — see PRODUCT_SOURCE_OF_TRUTH D-1.** |
| 6 | Pass → Qualify (certify) | **WORKING** | `certifyEvaluation`: → PASSED + adminHold QUALIFIED, inserts immutable `account_qualifications` (ELIGIBLE), publishes `evaluation.qualified`. |
| 7 | Qualify → Fund | **WORKING** | `approveFunding`: qualification ELIGIBLE → FUNDED, provisions a FUNDED_SIM account (funding does not consume an active slot). Publishes `funding.approved` + `account.funded`. |
| 8 | Fund → FUNDED certificate | **WORKING** | `account.funded` → recognition issues FUNDED_TRADER cert; v1 master template present on disk. |
| 9 | Funded → Trade funded | **WORKING (simulation)** | Same server-authoritative terminal against the funded profile. |
| 10 | Trade funded → Earn winning days | **WORKING** | Winning day = net ≥ $150; 5 required before first payout. Enforced in `payout-core.ts` eligibility. |
| 11 | Winning days → Request payout | **WORKING** | `requestPayout`: advisory lock + optional idempotency key + eligibility re-check; caps = `min(withdrawable, productCap, 50%)`. |
| 12 | Request → Approve payout | **WORKING** | `approvePayout`: the single balance debit; version CAS; unique `(request, entry_type)` ledger key → double-debit structurally impossible; M7 hold check. |
| 13 | Approve → Submit/settle | **MOCKED / UNCONFIGURED** | Operational pipeline (RECEIVED..RECONCILED, STP fast lane) is built and wired, but the settlement **provider is mock (dev) or UnconfiguredPayoutProvider (fail-closed in prod)**. **No real bank/ACH rail exists.** |
| 14 | Settle → PAID | **MOCKED** | `markPaid` writes a SETTLEMENT ledger entry `meta:{mock:true}`; no real disbursement. At the 5th cycle publishes `account.completed`. |
| 15 | PAID → Payout certificate | **WORKING** | `payout.paid` → recognition issues PAYOUT cert (and cumulative club certs/achievements); v1 master present. |
| 16 | PAID → Permanent history | **WORKING** | `account_lifecycles` (append-only, endReason), immutable `account_qualifications`, hash-chained audit log; certificates immutable + publicly verifiable; a returned payout never deletes cert history. |

## The one truly broken leg for a real business

Everything on this path is **wired and server-authoritative**, but the two economic
endpoints that touch the outside world are **not connected to reality**:

- **Money in (arrow 1–2):** Whop is sandbox-only; the fallback is a self-signing mock with
  **no production guard**. There is no verified real charge path.
- **Money out (arrow 13–14):** there is **no real payout rail at all** — mock in dev,
  fail-closed in prod.

So the Golden Path is **end-to-end demonstrable in simulation** and **not yet capable of
taking or disbursing real money.** That is the honest state: the machine runs the full loop
on paper.

## Highest-risk arrows for a launch

1. **Arrow 3 (KYC gate)** — identity provider fails open to a fabricating mock (HTF-2).
   Launching without wiring Stripe Identity means the compliance gate passes on fake
   verification.
2. **Arrows 1–2 (purchase)** — commerce provider fails open to mock (HTF-1). Launching
   without Whop prod means accounts can be provisioned with no real payment.
3. **Arrows 13–14 (payout settlement)** — no real rail; must be built + reconciled before any
   real disbursement.
4. **Arrow 5 (rules)** — the drawdown model a customer is judged by (DB STATIC) differs from
   what they were sold (EOD_TRAILING). A commercial/legal exposure, not a wiring break.

## PROVENANCE

Compiled from the commerce/lifecycle, payouts/certs, and Atlas/execution/risk subagent
traces, cross-checked against `MONEY_FLOW.md` and `ACCOUNT_STATE_MACHINE.md`. No step was
executed end-to-end as a live integration test in this phase; each arrow's status reflects
verified wiring + provider reality. Money/provider-critical arrows verified personally.
Nothing on the path was implemented or modified.
