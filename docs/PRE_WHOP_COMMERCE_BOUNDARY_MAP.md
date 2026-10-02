# Pre-Whop Commerce → Provisioning Boundary Map

**Phase:** Pre-Whop Commerce Readiness — Phase 1. **Branch:** `claude/futures-trading-simulator-v8qefu`.
**Baseline:** `09d03c9` (tag `pre-whop-commerce-readiness-phase1-start`). **Method:** traced from code
(three forensic passes), not assumed. Provider-neutral — **Whop is NOT integrated in this phase.**

The question this answers: *when the next phase feeds a verified external commerce event, does Happy Trader
already turn it into exactly one correct account, with every failure visible and recoverable?* Short answer:
**yes** — the chain is one authoritative, idempotent, transactional path, already proven by extensive
concurrency/crash/multi-instance tests. This phase closed three real gaps (GAP-A/B/C below) and documents the
rest for the Whop phase.

## The chain (authoritative spine)

```
VERIFIED COMMERCE EVENT  (commerce_events row; provider-neutral NormalizedCommerceEvent)
   → CUSTOMER IDENTITY   (users.id, 1:1 with customer_identities)
   → ORDER               (commercial_orders; idempotency-keyed)
   → PRODUCT VERSION     (account_profile_versions, pinned at order)
   → ENTITLEMENT         (entitlements; one per (order, kind))
   → ACCOUNT PROVISIONING(provisionAccount; one per entitlement, advisory-locked)
   → PORTAL / OWNER OS / RECONCILIATION
```

One authoritative fulfilment path: every paid/granted order funnels through `fulfillCompletedOrder`
(`commerce.ts:336`) → `grantEntitlement` → `provisionFromEntitlement` → `provisionAccount`. Entry points that
reach it: the webhook `PAYMENT_SUCCEEDED` (`http/routes/commerce.ts`), the non-prod mock webhook,
`simulateProviderPayment`, the recovery sweep `retryPendingProvisioning`, event-driven recovery
`registerProvisioningRecovery`, the admin retry route (`http/routes/customers.ts`), and the admin grant
`acquireEvaluation`. `provisionAccount` has other callers that create accounts WITHOUT a purchase
(`approveFunding` — earned; admin-direct; machine route; practice; seed) — account creation is multi-caller,
but **account-from-a-purchase is single-path**.

## Stage-by-stage

| Stage | Authoritative source | Idempotency / safety | Event | Customer | Operator | Classification |
|-------|----------------------|----------------------|-------|----------|----------|----------------|
| Product → version → price | `account_profiles` + `account_profile_versions` (immutable, append-only); price `config.display.priceMicros` (informational) | unique `(profileId, version)` | — | checkout | Products console | **CONNECTED** |
| Verified event | `commerce_events` + `NormalizedCommerceEvent` (`commerce-provider.ts`) | unique `(provider, providerEventId)` replay guard (`schema.ts:1794`); signature verified; `payloadDigest` | `commerce.event_received` | — | Customer 360 | **CONNECTED** |
| Order | `commercial_orders` | unique `(org, idempotencyKey)` (`schema.ts:514`); `FOR UPDATE` on `markOrderCompleted` | `commercial_order.completed/created` | Billing | Customer 360 | **CONNECTED** |
| Amount/currency | order `amountMicros`/`currency` vs confirmed event | **GAP-B (now fixed):** rejects present mismatch with `PRICE_MISMATCH` (`http/routes/commerce.ts`) | — | truthful reject | event REJECTED | **CONNECTED (repaired)** |
| Entitlement | `entitlements` | unique `(commercialOrderId, kind)` (`schema.ts:552`) | `entitlement.granted` | — | Customer 360 | **CONNECTED** |
| Account provisioning | `provisionAccount` (`provisioning.ts`) | `FOR UPDATE` on entitlement + `provisioning_requests` key + **GAP-A (now fixed):** per-(org,key) advisory lock serialises direct callers too | `entitlement.provisioned`, `account.created/activated` | portal account | Customer 360 | **CONNECTED (hardened)** |
| Active cap (≤5) | `assertActiveSlotAvailable` (`account-limit.ts`) | `pg_advisory_xact_lock` per user, inside the creation tx | `AccountLimitError` → `PROVISION_BLOCKED` | pending/park | exception queue | **CONNECTED** |
| Reset | `account-reset.ts` → same entitlement path, kind `RESET` | order key `reset:<failedId>` + entitlement unique + **RES-4** partial unique `accounts_reset_of_key` (`schema.ts:416`) | as above | new account, old preserved | Customer 360 | **CONNECTED** |
| Provisioning failure | order status `PROVISION_BLOCKED`/`PROVISION_FAILED` (`setProvisionState`) | money kept; recoverable | `entitlement.provisioning_blocked/failed` | truthful pending/needs-attention | exception queue + retry | **CONNECTED** |
| Retry / recovery | `fulfillPurchaseGated` / `retryPendingProvisioning` | re-reads DB state; idempotent | `commerce.provisioned` | — | audited retry button | **CONNECTED** |
| Reconciliation | `runIntegrityChecks` (`resilience/integrity-checks.ts`) + owner read-models | **GAP-C (now fixed):** added `ORDER_PROVISIONED_NO_ENTITLEMENT`, `ENTITLEMENT_CONSUMED_NO_ACCOUNT` | — | — | integrity:check + exception queues | **CONNECTED (repaired)** |
| Portal Billing | `GET /portal/orders` (`portal-billing.ts`) | real `commercial_orders`, owner-scoped | — | order → account provenance | — | **CONNECTED** |
| Audit | hash-chained `audit_log` | append-only; tamper-evident | — | — | Customer 360 audit | **CONNECTED** |
| Identity binding | `users.id` (1:1 with `customer_identities`) | permanent bijection | — | — | — | **PARTIAL** (documented) |
| Product mapping (external→internal) | internal `productKey` at checkout; `whopPlanId` is internal→external only | — | — | — | — | **NOT STARTED** (Whop-phase) |
| Outbox delivery of commerce events | in-process `events.publish` → `domain_events` (no drainer); `account.changed` via outbox | durable as rows inside the tx on the commerce path | — | — | — | **PARTIAL** (documented) |

## Gaps repaired this phase (root cause)

- **GAP-A — direct-caller exactly-once (§6/§7/§8/§30).** `provisionAccount` inserted the account before the
  `provisioning_requests` row with no per-key serialisation; the commerce/funding paths were safe (FOR UPDATE
  on the entitlement/qualification) but direct callers (admin-direct, machine route) could double-provision
  under truly-concurrent identical keys. **Fix:** a per-`(org, idempotency-key)` `pg_advisory_xact_lock` taken
  at the top of the creation transaction, with an in-lock re-check that returns the committed account. Now
  exactly-once for every caller. Test: `provisioning-idempotency.test.ts` (8 concurrent racers → 1 account).
- **GAP-B — amount/currency consistency (§10).** No code compared the confirmed amount/currency to the order;
  `PRICE_MISMATCH` was reserved but never used. **Fix:** the `PAYMENT_SUCCEEDED` handler now rejects a present
  amount or currency that contradicts the order (`PRICE_MISMATCH`), while a provider that asserts no amount is
  not blocked. Test: `commerce-fulfillment.test.ts` (mismatch rejected, match provisions).
- **GAP-C — commerce-chain reconciliation (§17).** `integrity:check` detected only the active-cap among the
  commerce conditions. **Fix:** two precise detectors added to the existing framework —
  `ORDER_PROVISIONED_NO_ENTITLEMENT` and `ENTITLEMENT_CONSUMED_NO_ACCOUNT` (both P1, true invariants with no
  transient window). Test: `commerce-integrity.test.ts`.

## Gaps documented for the Whop phase (not built — see readiness matrix)

- **Identity binding (PARTIAL).** Orders/entitlements/accounts bind to `users.id`. Since `customer_identities`
  is 1:1 and permanent with `users` (unique on `userId`), `users.id` IS the permanent identity via a stable
  bijection — no schema migration is needed. The Whop adapter must resolve an external customer to the Happy
  Trader `users.id` through the `customer_identities` spine and never mint a duplicate identity for a differing
  external email. (No speculative KYC built, per scope.)
- **External→internal product mapping (NOT STARTED).** The current model is Atlas-initiated checkout (Atlas
  creates the PENDING order and resolves the product by internal key; the provider confirms via `atlasOrderId`).
  In that model no webhook-time external→internal mapping is required. A provider-INITIATED checkout (Whop
  hosts it, Whop creates the order) would need it; the `UNKNOWN_PRODUCT` reject reason is already reserved. The
  checkout model is a Whop-phase decision — left as a matrix item rather than a speculative table.
- **Outbox delivery of commerce domain events (PARTIAL).** The ACCOUNT itself is durable and recovered by
  startup sweeps; commerce `domain_events` commit as rows inside their transaction but have no drainer, and the
  direct-provision (non-purchase) path publishes `account.created`/`account.activated` after commit (a
  lost-event window for practice/admin-direct, not for purchases). Re-architecting the event bus is out of
  scope; documented for the Whop phase with the precise recommendation.

Nothing in this phase changed a business rule, added a product/price, or integrated Whop.
