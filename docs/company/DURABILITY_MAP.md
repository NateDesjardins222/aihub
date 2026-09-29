# Durability Map

**Engineering Resilience Phase 2** · Base `4c4570d` · 2026-09-29

Every critical entity, classified by where its authority lives and how it is
reconstructed. All authority is in PostgreSQL; nothing critical lives only in
process memory. Money is integer micro-dollars.

**Classes** — DURABLE AUTHORITY (the source of truth, in Postgres) · DERIVED DURABLE
(persisted but recomputable from authority) · REBUILDABLE CACHE (in-memory,
rebuilt from Postgres) · VOLATILE (in-memory, safe to lose) · EXTERNAL (owned by a
provider). A critical financial/risk/account authority that were VOLATILE-only
would be P0/P1 — **none is.**

| Entity | Class | Table(s) | Txn owner | Unique / idempotency | Version | Reconstruct from | Reconcile |
|---|---|---|---|---|---|---|---|
| Customer identity | DURABLE AUTHORITY | `users`, `customer_identities` | auth/onboarding | `users.email` unique | — | — | — |
| Entitlement / purchase | DURABLE AUTHORITY | `commercial_orders`, `entitlements` | `commerce.ts` | `commercial_orders(org,idemKey)`, `entitlements(order,kind)` | order status guard | commerce event ledger | `retryPendingProvisioning` |
| Account | DURABLE AUTHORITY | `accounts` | `provisioning.ts` | `accounts.public_id`; `ent:/fund:/reset:/practice:` provisioning keys | `seq` | — | integrity checks |
| Account profile version (rules) | DURABLE AUTHORITY (immutable) | `account_profile_versions` | `profiles.ts` | `(profileId,version)` | version | — | product-integrity tests |
| Account lifecycle | DERIVED DURABLE | `account_lifecycles` | `provisioning`/`commerce` | `(accountId,seq)` | seq | account status machine | sweeps |
| Risk controls (personal) | DURABLE AUTHORITY | `trader_risk_controls`, `trader_risk_control_events` | `personal-risk.ts` | `(accountId,controlType)` | `version` (opt-in CAS) | in-txn event log | — |
| Orders | DURABLE AUTHORITY | `orders` | `engine.ts submitLocked` | `(accountId,clientOrderId)` | `version` (opt-in on modify) | — | — |
| Executions | DURABLE AUTHORITY | `executions` | `engine.ts matchLocked` (one txn) | insert-only; `seq` monotone | — | — | position/P&L oracle (`reconcile.ts`) |
| Positions | DERIVED DURABLE | `positions` | `engine.ts matchLocked` (same txn as executions) | `(accountId,symbol)` | — | **fold `applyFill` over `executions`** | `reconcileAccount` |
| Realized P&L | DERIVED DURABLE | `accounts.realized_pnl_micros`, `trades` | `matchLocked` (same txn) | — | — | recompute from `executions` | `reconcileAccount` |
| Daily / EOD state | DERIVED DURABLE | `daily_account_stats`, `accounts` counters/floor | `engine.ts rulesLocked` (**one txn, RES-3 fixed**) | `daily_stats(account,date)` | — | idempotent roll replay | replay + integrity |
| Payout request | DURABLE AUTHORITY | `payout_requests` | `payouts.ts` | `(org,idemKey)` | `version` (CAS) | — | ledger reconciliation |
| Payout payment/op state | DURABLE AUTHORITY | `payout_operations`, `payout_submission_attempts`, `payout_provider_events` | `payout-operations.ts` | `(request)`, `(request,attempt#)`, `(provider,eventId)` | op state machine | provider reconcile | `reconcilePayout` |
| Money ledger | DURABLE AUTHORITY (append-only) | `payout_ledger` | `payouts.ts` / `payout-operations.ts` | `(request,entryType)` | — | — | `reconcileAccount` balance identity + arithmetic |
| Admin adjustments | DURABLE AUTHORITY (append-only) | `admin_adjustments` | `account-ops.ts` | — | — | — | financial-ops sum |
| Certification/qualification | DURABLE AUTHORITY | `account_qualifications` | `commerce.ts` | `(account,lifecycle)`; `fund:<qualId>` | funding state | — | `certifyPassedEvaluations` / `fundEligibleQualifications` |
| Audit chain | DURABLE AUTHORITY (append-only, tamper-evident) | `audit_log` | `audit.ts recordAudit` | per-org hash chain, advisory-locked; DB rejects UPDATE/DELETE | monotone `createdAt` | — | `verifyAuditChain` |
| Outbox | DURABLE AUTHORITY (delivery ledger) | `outbox_events` | enqueued in caller txn; `outbox.ts` worker | (none; at-least-once) | attempts + deadLetter | — | `outboxStats` |
| Domain events / projections | REBUILDABLE CACHE | `domain_events`, `account_projections` | `events.ts` + projection worker | — | stateVersion | recompute from authority | projection rebuild |
| Kill switches / feature flags | DURABLE AUTHORITY | `kill_switches`, feature flags | owner config | key unique | — | — | — |
| Engine in-memory `activeSymbols`, mutex, quote cache | REBUILDABLE CACHE / VOLATILE | — | — | — | — | re-read Postgres on `start()` / each pass | — |
| Provider payout outcome | EXTERNAL | (provider) | — | stable idem key | — | provider `getPayout`/reconcile | `reconcilePayout` |

## Findings from the map

- **No critical financial/risk/account authority is VOLATILE-only.** The engine
  caches nothing authoritative: positions, working orders, brackets, risk state
  and the drawdown floor are all read from Postgres on demand and rebuilt on
  `start()` (`engine.ts refreshActiveSymbols`, `syncBrackets`). Losing the process
  loses only caches.
- **Positions and realized P&L are DERIVED DURABLE**: they are persisted for speed
  but can be recomputed exactly from the immutable `executions` history — this is
  the reconciliation oracle (`platform/resilience/reconcile.ts`). `executions.realized_pnl_micros`
  is intentionally 0; realized P&L is recomputed from the (side, qty, priceTicks)
  sequence.
- **The money ledger is append-only** and satisfies an exact balance identity
  (`balance = starting + realized − fees − net payout`), checked by
  `reconcileAccount`.
- **RES-4** added a DB-level partial unique index on `accounts.reset_of_account_id`
  so the "one reset successor" invariant is enforced by the database, not only the
  application key.
