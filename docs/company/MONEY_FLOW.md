# MONEY FLOW MAP

**Phase 2 — System-Wide Reconciliation. Audit-only. No money was moved and no exploit was run.**

Baseline HEAD: `55df4c7` · Compiled 2026-09-25 from a full-stack boot + code trace.

## The single most important fact

**No real money moves anywhere in this build.** Every "amount" is one of:
- a **SIMULATED** value (paper-trading P&L / balances),
- a **MODELED** value (economics engine, treasury projections),
- a **DISPLAY-ONLY record** (commerce order amounts — the real charge, if any, happens
  in an external processor), or
- a **RECORD-ONLY** ledger entry whose settlement provider is **mock or unconfigured**.

The trading engine header states it outright: the browser "may REQUEST … may never ASSERT
… Every number originates here" (`apps/server/src/trading/engine.ts:1-11`). Account balances
are written by the engine as `realizedPnl - fees` (`engine.ts:1833`) in a `SimulationEnvironment`.

Classification vocabulary used below: **REAL** (moves actual funds) · **SIMULATED**
(paper) · **MODELED** (scenario math) · **DISPLAY-ONLY** (informational record) ·
**RECORD-ONLY** (durable ledger, no live settlement rail).

---

## Every money / money-like entry point

| Flow | Classification | Ledger / table | Writer | Settlement reality |
|------|----------------|----------------|--------|--------------------|
| **PURCHASE** (evaluation) | DISPLAY-ONLY record | `commercial_orders.amountMicros` | `commerce.ts` `createPendingOrder` / `completeCommercialOrder` | No cash moves in-app; `amountMicros` is "informational" (schema.ts:458-459, commerce.ts:12). Real charge is external (Whop sandbox / mock). |
| **RESET** (re-buy failed eval) | DISPLAY-ONLY record | `commercial_orders` source=RESET | `account-reset.ts` `createResetOrder` | Re-purchase at the failed account's **original price** (no discount); same checkout path. |
| **REFUND** | REAL-MONEY-RECORD (state only) | `commercial_orders.status=REFUNDED` + entitlement REVOKE + account hold | `commerce-refund.ts` `handleRefund` | Records the refund + contains the account; no in-app cash reversal. History preserved. |
| **CHARGEBACK / DISPUTE** | REAL-MONEY-RECORD (containment) | audit + event + account hold | `commerce-refund.ts` `handleDispute` | Holds linked account, reverses affiliate commission; no auto-confiscation. |
| **AFFILIATE COMMISSION** | MODELED liability, append-only | `affiliate_ledger` (authority) + `affiliate_commissions` | `affiliate-commissions.ts` `processConversion` | Exactly-once per order (advisory lock `ACOM` + unique conversion). Mature/reverse/adjust idempotent. |
| **AFFILIATE PAYOUT** | RECORD-ONLY, provider NOT_CONFIGURED | `affiliate_payouts` + `affiliate_ledger` PAYOUT_PAID(−) | `affiliate-payouts.ts` | `affiliatePayoutProviderStatus()` truthfully NOT_CONFIGURED — "nothing is ever sent." |
| **TRADER PAYOUT** | SIMULATED settlement | `payout_ledger` DEBIT@APPROVED + SETTLEMENT@PAID(mock) | `payouts.ts` `approvePayout` / `markPaid` | Debits the **simulated** account balance; no real disbursement. Mock/unconfigured provider. |
| **PAYOUT REVERSAL / RETURN** | RECORD-ONLY | `payout_reconciliation_records` + op RETURNED | `payout-operations.ts` | Never un-pays; keeps certificate history. |
| **PROCESSING FEE** | MODELED / gate | economics `processingPct`; ops `treasuryGate` | economics engine / `payout-ops-config.ts` | Not charged in the real path; `SplitAccounting.feesMicros = 0` in engine (`payout-core.ts:135`). |
| **TREASURY RESERVE** | MODELED / gate-only | economics `reserveModel`; ops circuit breaker | economics engine / `payout-ops-config.ts` | No reserve ledger; treasury is a *gate* not an account. |
| **ADMIN ADJUSTMENT** | REAL-MONEY-RECORD (sim balance) | `admin_adjustments` | `account-ops.ts:82` | Adjusts the **simulated** balance; audited. |
| **PHYSICAL CERT ORDER** | RECORD-ONLY, provider MOCK | `physical_certificate_orders` | `physical-orders.ts` | Retail $99.99; MockFulfillmentProvider; Prodigi DISABLED. |
| **ECONOMICS SIM** | MODELED | `economics_runs` (insert-only) | economics v1 + v2 engines | Never touches production data; SUPER_ADMIN only. |
| **TRADING P&L / BALANCE** | SIMULATED (paper) | `accounts.balanceMicros` | `trading/engine.ts:1833` | Paper trading against a delayed/dev feed. |

---

## The trader payout economic path (the one that debits a balance)

This is the most carefully-guarded money path and is worth stating precisely, because it is
where "simulated money" behaves most like real money.

1. **Request** — `requestPayout` (`payouts.ts:274-340`): account advisory lock + optional
   idempotency key + `FOR UPDATE` + re-run eligibility. `ALREADY_PENDING` guard.
2. **Eligibility** — pure `payout-core.ts` `evaluatePayoutEligibility`: account-status
   blocks, `MAX_CYCLES_REACHED` (cap 5), model gates, winning-days, SELECT consistency,
   DAILY buffer + balance-progression. Caps: `min(withdrawable, productCap, 50% of withdrawable)`.
3. **Approve** — `approvePayout` (`payouts.ts:393-501`): **the single balance debit.**
   Version CAS, re-verify under lock, M7 enforcement-hold check, debit once, append-only
   `payout_ledger` DEBIT with **unique `(request, entry_type)`** → double-debit is
   structurally impossible.
4. **Operational pipeline** — `payout-operations.ts`: RECEIVED → checks → PAYABLE →
   submit → provider events → RECONCILED. Stable idempotency key `reqId:ordinal:provider`;
   LOST_ACK/TIMEOUT reconcile via `getPayout`, **never blind-retry**; HTTP 200 ≠ PAID.
5. **Paid** — `markPaid` (mock settlement): **no further balance movement** (debit already
   happened at APPROVED); writes SETTLEMENT ledger `meta:{mock:true}`; at the 5th cycle
   publishes `account.completed`.
6. **Certificate** — `payout.paid` event → recognition issues a PAYOUT certificate.

The split is 90/10 with banker's rounding, firm absorbs the remainder (zero drift),
integer micros only (`payout-core.ts:102-137`).

---

## Double-processing / idempotency observations (theoretical — NOT tested or exploited)

Strong idempotency was found on: trader payout (advisory lock + FOR UPDATE + version CAS +
unique ledger key), payout ops (stable key, `onConflictDoNothing`, provider idempotency,
`SKIP LOCKED` worker), certificates/achievements (unique `(org, dedupeKey)`), physical
orders (idempotency key + status guard), affiliate commission (advisory lock + unique
conversion), commerce webhooks (`commerce_events` dedup before any provisioning),
provisioning (`ent:<id>` / `fund:<qual>` keys + request-hash mismatch guard).

**One flagged gap (needs revalidation, not exploited):** `affiliate-payouts.ts`
`markPayoutPaid` (~:86-100) and `transition` (~:63-70) select the row **without `FOR UPDATE`
and without a status-CAS in the UPDATE WHERE clause**, and no unique `(payoutId, entryType)`
constraint on `affiliate_ledger` was observed. Two concurrent `markPayoutPaid` on an
APPROVED affiliate payout could each insert a `PAYOUT_PAID` (−amount) entry, theoretically
double-debiting the affiliate ledger. Unlike the trader-payout path there is no advisory
lock here. **Recommendation:** confirm a DB constraint or add a row-lock/CAS. Recorded in
`KNOWN_ISSUES.md` as a P2 (no real money rail is wired today, so blast radius is currently
a ledger record, not cash). *This finding is from a subagent trace and is marked
NEEDS-REVALIDATION — it was not reproduced by a concurrency test in this phase.*

---

## The fail-open provider risks (verified personally, see `KNOWN_ISSUES.md`)

Two provider selectors fall back to a **mock with no production guard**, in contrast to the
payout registry which explicitly refuses the mock in production:

- `commerceProviderFromEnv()` → `whop.isConfigured() ? whop : mock`
  (`commerce-provider.ts`). In a production deploy without Whop configured, the **mock
  self-signs `PAYMENT_SUCCEEDED` events** (it holds its own dev secret) and would provision
  paid evaluation accounts **with no real payment**. The owner console does surface the
  active provider name ("mock"), so it is observable, but nothing *prevents* it.
- `identityProviderFromEnv()` → `stripe.isConfigured() ? stripe : mock`
  (`identity-providers.ts`). In production without Stripe Identity, **KYC decisions are
  fabricated from the legal name**, and the provisioning gate's `identityOk` would pass on
  fabricated verification.

Compare `payout-provider-registry.ts`: `if (id === 'MOCK') { if (isProduction()) return
unconfigured; ... }`. That is the correct fail-closed pattern the other two selectors do
not follow.

**Why this matters for money flow:** these are the two places where the "no real money"
safety actually depends on *configuration* rather than *code*. If Happy Trader launches
without wiring Whop + Stripe, purchases and identity are silently faked while everything
else behaves as if they were real — the one asymmetry in an otherwise fail-closed system.

---

## PROVENANCE / LIMITATIONS

- Payout / certificate / economics / commerce ledger tracing: subagent code audits, cross-checked
  against the schema and the live DB table inventory (135 tables; all money/ledger tables
  present and empty on a fresh seed).
- Provider fail-open items: **verified personally** by reading the two selector functions and
  the payout registry.
- No concurrency/race test was run against the affiliate-payout gap; it is a static-analysis
  finding marked NEEDS-REVALIDATION.
- No destructive or exploit testing was performed (Phase 2 constraint).
