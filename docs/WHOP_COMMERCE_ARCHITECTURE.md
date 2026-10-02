# Whop Commerce Architecture (thin adapter)

**Phase:** Whop Commerce Integration — Phase 1. **Baseline:** `9ee0e51` (tag `whop-commerce-phase1-start`).
Companion: `WHOP_PROVIDER_CONTRACT.md` (verified Whop facts), `WHOP_CORE50_CANARY_RUNBOOK.md` (how to run it),
`WHOP_COMMERCE_PHASE1_REPORT.md` (results), `WHOP_INTEGRATION_READINESS_MATRIX.md` (per-responsibility status).

## The principle

Whop is a **commerce provider** — a trigger into Happy Trader's domain, never the owner of it. Happy Trader
remains authoritative for accounts, risk, evaluation rules, funded state, payouts, certificates, trading, P&L
and the customer lifecycle. The pre-Whop phase built and hardened a provider-neutral commerce boundary; this
phase feeds Whop into it and closes the last canary gaps. **No business rule changed; no product/price added;
no second provisioning or reconciliation engine was built.**

## The chain

```
HAPPY TRADER WEBSITE  (signed-in trader picks CORE 50K)
   → POST /api/v1/checkout              createPendingOrder (PENDING, $95 pinned, atlasOrderId)
   → Whop checkout_configuration        metadata { atlasOrderId }, redirect_url → portal
   → [ buyer pays on Whop's surface — Atlas never sees a card ]
   → POST /api/v1/webhooks/whop         Standard Webhooks signature verified over the RAW body
      → WhopCommerceProvider.verifyEvent / normalizeEvent   (the ADAPTER — the only Whop-shaped code)
      → recordCommerceEvent              commerce_events dedup on (provider, providerEventId)
      → [PAYMENT_SUCCEEDED] plan cross-check (UNKNOWN_PRODUCT) + amount/currency guard (PRICE_MISMATCH)
      → markOrderCompleted → fulfillPurchaseGated → fulfillCompletedOrder
         → grantEntitlement (unique (order, kind)) → provisionFromEntitlement → provisionAccount (advisory-locked)
   → CUSTOMER PORTAL  (GET /commerce/orders/:id/status, GET /portal/orders)  → ATLAS (account truth)
   → OWNER OS  (Customer 360: order ↔ provider event ↔ entitlement ↔ account; audited retry)
   → RECONCILIATION  (runIntegrityChecks + owner read-model exception queues)
```

Everything after the adapter is the UNCHANGED, provider-neutral domain. The adapter's entire job is: verify the
raw webhook, then produce a `NormalizedCommerceEvent` and persist it. Business provisioning depends only on the
normalized event and the internal order it names — never on a Whop JSON shape.

## The adapter (the only Whop-aware code)

- **`whop.ts`** — `verifyStandardWebhook` (signature, timestamp tolerance, rotation, timing-safe) and
  `parseWhopEvent` (reads `atlasOrderId`, receipt, `plan.id`, `user.id`, `subtotal/total`, `currency` out of the
  verified v1 payload, tolerantly, never throwing).
- **`whop-client.ts`** — SANDBOX-only REST client: `POST /api/v1/checkout_configurations` with
  `metadata { atlasOrderId }`. Credential-gated; not on the money path.
- **`commerce-provider.ts`** — `WhopCommerceProvider` implements the provider interface over the two above;
  `normalizeEvent` emits the provider-neutral `NormalizedCommerceEvent` (now including `providerProductId` and a
  real `amountMicros` via `dollarsToMicros`). `commerceProviderFromEnv()` selects Whop whenever
  `WHOP_WEBHOOK_SECRET` is set; the mock is NEVER selected in production.

## Product mapping (one authoritative seam)

`whop-product-map.ts` is the single place a Whop plan binds to an internal product, driven by the config-only
`WHOP_PLAN_MAP` JSON (`{ "<internal product key>": "<Whop plan id>" }`), with the product's own `whopPlanId` as
fallback. Both directions use it:
- **Checkout** picks the plan for the order's product (`whopPlanForProduct`).
- **Webhook** cross-checks the paid `plan.id` against the order's expected plan; a contradiction is
  `UNKNOWN_PRODUCT` and never provisions. An unmapped plan is unknown.

The CORE 50K canary is ONE `WHOP_PLAN_MAP` entry. Adding the other nine products is extending that JSON —
configuration, not an architecture change. Display name, description, price and URL slug are never used to pick a
product.

## Identity resolution

Atlas-initiated: the checkout runs under `requireUser`, so the PENDING order carries the authoritative
`users.id`; `atlasOrderId` (set server-side, echoed in metadata) is the secure correlation. The webhook resolves
the customer via that order, not via Whop's customer object or email. Cases:
- **New customer** → signed up in Happy Trader before checkout; the order already binds their `users.id`.
- **Existing customer** → same.
- **Email changed on Whop** → irrelevant; binding is by order → `users.id`, not email.
- **Duplicate email** → `users` is unique on email; no duplicate identity is minted.
- **Unknown / unresolvable** (no `atlasOrderId`, or the order is missing) → `UNKNOWN_ORDER`, reject, never
  provision. A provider-initiated purchase with only a plan id (no order) is a documented Whop-Phase-2 item; the
  `productKeyForWhopPlan` reverse resolver and `UNKNOWN_PRODUCT` reason are already in place for it.

## Money truth is server-side only

A browser return, redirect, query param or client callback NEVER provisions. Only a signature-verified
server-side `payment.succeeded` enters the verified boundary. Proven by `commerce-whop-canary.test.ts`
("an unsigned body never provisions"). The customer sees truthful states from `GET /commerce/orders/:id/status`
(PENDING → COMPLETED → PROVISIONED, or PROVISION_BLOCKED/FAILED), never a fabricated completion.

## Exactly-once (layered, all pre-existing, all reused)

`commerce_events` unique `(provider, providerEventId)`; `commercial_orders` unique `(org, idempotencyKey)` +
`FOR UPDATE` on completion; `entitlements` unique `(commercialOrderId, kind)`; `provisionAccount` per-`(org,key)`
advisory lock + `provisioning_requests` key + `FOR UPDATE` on the entitlement. The account cap (≤5) is a
per-user advisory lock inside the creation transaction. Proven for Whop by the 10-concurrent-delivery canary
test and the existing commerce-chaos / multi-instance / crash-recovery suites.

## Failure, retry, recovery

A verified payment that cannot provision parks `PROVISION_BLOCKED` / `PROVISION_FAILED` (money recorded first,
never lost), is visible in the owner provisioning exception queue and the customer status endpoint, and is
recoverable via the audited `POST /customers/orders/:id/retry-provisioning` (→ `fulfillPurchaseGated`, which
re-reads persisted state — it does not fake another Whop event, order, entitlement or account) or the startup
sweep. Retry after a process interruption is idempotent by the same keys.

## Refund / cancellation / dispute readiness

Mapped to `REFUND` / `DISPUTE_OPENED` / `DISPUTE_CLOSED` and routed to the existing `handleRefund` /
`handleDispute`. Happy Trader's refund rule (refund only if no trade) is unchanged. No account is destroyed
automatically on a guessed provider event; undefined business responses persist provider truth and raise
operator attention. Full automation of provider-initiated refunds/disputes is a documented Whop-Phase-2 item.

## Owner correlation (now implemented)

Customer 360 (`owner-customer.ts` → `customerDetail`) returns, per customer: the orders (with provider, amount,
currency, provider reference), the `providerEvents` that name those orders (provider, event id, kind,
`signatureOk`, status, `rejectReason`, provider customer id, receipt, amount), the entitlements, and the
accounts — so Nathan can trace Whop → order → entitlement → account, and see rejected/duplicate events and why,
without SQL. The web Customers page renders both tables.

## What this phase did NOT do

No production Whop host; no auto-refund/dispute destruction; no new product/price/provider; no change to any
business rule; no second reconciliation or provisioning engine; no guessed Whop field, event, header, URL or SDK
call. The other nine products remain unmapped (no fabricated Whop ids).
