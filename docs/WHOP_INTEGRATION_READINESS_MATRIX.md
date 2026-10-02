# Whop Integration Readiness Matrix

**Phase:** Pre-Whop Commerce Readiness — Phase 1 (output for the next phase). **Baseline:** `09d03c9`.
This maps each future Whop responsibility to its internal Happy Trader destination and marks readiness. It is
the input to the **Whop Commerce Integration** phase. **No Whop specifics are guessed here** (per §36); Whop
event names, headers, SDK methods and APIs will be verified against current official Whop documentation in that
phase.

Legend: **READY** = internal side is done and tested; **PARTIAL** = works but with a documented gap;
**WHOP-PHASE** = deliberately deferred to the integration phase (a thin adapter or a provider-specific decision).

| # | Whop responsibility | Internal Happy Trader destination | Readiness | Remaining for the Whop phase |
|---|---------------------|-----------------------------------|-----------|------------------------------|
| 1 | Webhook authenticity (signature) | `WhopCommerceProvider.verifyEvent` (`commerce-provider.ts`) via Standard Webhooks; `WHOP_WEBHOOK_SECRET` | **PARTIAL** | Confirm Whop's current signature scheme/headers against official docs; set the production secret. |
| 2 | Event normalisation | `NormalizedCommerceEvent` + `normalizeEvent` | **READY** (seam exists) | Verify Whop payload field names → the normalized shape; fill `parseWhopEvent`. |
| 3 | Event idempotency (replay) | `commerce_events` unique `(provider, providerEventId)` (`schema.ts:1794`) | **READY** | Confirm Whop's stable per-event id maps to `providerEventId`. |
| 4 | Order identity | `commercial_orders` unique `(org, idempotencyKey)`; event carries `atlasOrderId` metadata | **READY** | Ensure the Whop checkout carries `atlasOrderId` in metadata (Atlas-initiated model). |
| 5 | Checkout product mapping | internal `productKey` → pinned `account_profile_versions` at checkout; `config.whopPlanId` is internal→external | **PARTIAL / WHOP-PHASE** | Decide the checkout model. If Atlas-initiated: populate `whopPlanId` per product and done. If provider-initiated: add an external-product-id → internal-version resolver (reserve `UNKNOWN_PRODUCT` already exists). |
| 6 | Customer mapping | `users.id` (1:1, permanent with `customer_identities`) | **PARTIAL** | Resolve the Whop customer (`providerCustomerId`/verified email) to one Happy Trader `users.id` via the identity spine; never mint a duplicate identity. No schema change needed. |
| 7 | Payment confirmation | `markOrderCompleted` + `fulfillPurchaseGated` | **READY** | Map Whop's "payment succeeded" event kind → `PAYMENT_SUCCEEDED`. |
| 8 | Amount / currency validation | `PRICE_MISMATCH` check in the `PAYMENT_SUCCEEDED` handler (**added this phase**) | **READY** | Confirm whether Whop surfaces a confirmed amount; if so it is already validated against the order. |
| 9 | Entitlement | `grantEntitlement` unique `(order, kind)` | **READY** | None. |
| 10 | Account provisioning | `provisionFromEntitlement` → `provisionAccount` (advisory-locked, **hardened this phase**) | **READY** | None. |
| 11 | Reset purchase | `account-reset.ts` → same path; RES-4 partial unique index | **READY** | If reset is ever provider-initiated, carry the `reset-of:<id>` reference through Whop metadata. |
| 12 | Refund | `handleRefund` (internal semantics exist) | **PARTIAL / WHOP-PHASE** | Map Whop refund event → `REFUND`; confirm the "refund only if no trade" policy surfaces the facts the operator needs. |
| 13 | Cancellation / reversal / dispute | `DISPUTE_OPENED/CLOSED` handlers; cancellation behaviour | **PARTIAL / WHOP-PHASE** | Map Whop cancel/dispute events; define undefined behaviours (documented, not invented). |
| 14 | Reconciliation | `runIntegrityChecks` incl. commerce-chain detectors (**added this phase**); owner exception queues | **READY** | None. |
| 15 | Owner OS | Customer 360 (`owner-customer.ts`) + provisioning exception queue + audited retry (`customers.ts`) | **READY** (minor gaps) | Optional: inline order↔product↔amount↔account correlation + attempt-count column. |
| 16 | Portal Billing | `GET /portal/orders` (`portal-billing.ts`) | **READY** | None. |
| 17 | Audit | hash-chained `audit_log` over every commerce transition | **READY** | None. |
| 18 | Observability / provider event storage | `commerce_events` (status/signatureOk/rejectReason/payloadDigest) | **READY** | Decide raw-payload retention policy (currently digest only — no secrets). |
| 19 | Outbox delivery of commerce domain events | in-process `events.publish`; account durable via sweeps | **PARTIAL** | If proactive notifications must be crash-proof, route commerce events through the durable outbox + a `domain_events` drainer (a focused, separate change). |

## The provider-neutral contract Whop will feed

The Whop adapter's only job is: authenticate the raw webhook, then produce a `NormalizedCommerceEvent`
(`commerce-provider.ts`) and persist it via `recordCommerceEvent` into `commerce_events`. Everything downstream
(order → entitlement → account, idempotency, cap, reset, reconciliation, audit, portal, owner) is already
provider-neutral and tested. This is the anti-corruption boundary:

```
WHOP ADAPTER (verify signature, parse Whop JSON)
      ↓  NormalizedCommerceEvent  (provider, providerEventId, kind, atlasOrderId,
                                    providerCustomerId, receiptId, amountMicros,
                                    currency, occurredAt)
      ↓
commerce_events  (dedup on (provider, providerEventId))
      ↓
HAPPY TRADER COMMERCE DOMAIN  (unchanged, provider-neutral)
```

Business provisioning must never depend on Whop-specific JSON shapes; it depends only on the normalized event
and the internal order the event names.
