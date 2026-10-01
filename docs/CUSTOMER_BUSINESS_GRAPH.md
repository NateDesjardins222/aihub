# Customer Business Graph

The authoritative ownership spine of the Happy Trader customer system, traced in
code (Customer Product Integrity Phase 1). Every edge below is a real FK / domain
relation, not a frontend assumption.

```
AUTH USER (users.id)  ── 1:1 ──  CUSTOMER IDENTITY (customer_identities, unique user_id)
        │
        ├── PROFILE                 customer_identities (legalName, preferredDisplayName, createdAt=member-since)
        ├── ORDERS                  commercial_orders.user_id
        │       └── ENTITLEMENT     entitlements.commercial_order_id → entitlements.user_id
        │               └── ACCOUNT accounts (entitlements.consumed_by_account_id)
        │                            accounts.user_id (owner), profile_version_id (terms),
        │                            external_metadata = {entitlementId, commercialOrderId}
        ├── ACCOUNTS                 accounts.user_id
        │       ├── EXECUTIONS/POSITIONS/P&L/BALANCE  engine (authoritative), accounts.balance_micros
        │       ├── RISK/LIFECYCLE   risk.ts checkOrder (state-gated), account_lifecycles
        │       ├── QUALIFICATION    account_qualifications (eval pass → funded lineage)
        │       └── PAYOUTS          payout_requests.account_id + .user_id → payout_ledger
        ├── CERTIFICATES             certificates.customer_identity_id (+ account/payout source)
        ├── SUPPORT TICKETS          support_tickets.customer_user_id / customer_identity_id
        ├── AFFILIATE                affiliates.user_id + affiliate_applications
        ├── PERSONAL GOALS           personal_goals.customer_identity_id
        ├── ACHIEVEMENTS             achievements.customer_identity_id
        └── NOTIFICATIONS            notifications.customer_identity_id
```

## Identity is the root

`customer_identities.user_id` is UNIQUE (`schema.ts:1569`) — one durable identity per
auth user. Ownership is enforced server-side everywhere by `user_id` (accounts,
orders, payouts) or `customer_identity_id` (certificates, support, goals,
achievements, affiliate). **Email is never the ownership key** — it is a mutable
attribute on `users`; changing it does not move any business object.

## Account provenance (purchase → account)

`commercial_orders` (user_id, product_version_id, status) → `entitlements`
(commercial_order_id, user_id, product_version_id, kind, consumed_by_account_id) →
`accounts` (user_id, profile_version_id, external_metadata.commercialOrderId). Terms
are pinned at acquisition on order, entitlement, account, and (for funded) on
`funded_profile_version_id` — later product edits never mutate a sold account.

## Mutation authority (who writes what)

| Object | Creator / authority | Idempotency key |
|---|---|---|
| order COMPLETED | `markOrderCompleted` (signature-verified webhook only) | `commercial_orders_idem_key`, `commerce_events_provider_event_key` |
| entitlement | `grantEntitlement` | `entitlements_order_kind_key` |
| account (eval) | `provisionAccount` via `provisionFromEntitlement` | `provisioning_requests_key` + entitlement `consumed_by_account_id` |
| account (funded) | `approveFunding` on `evaluation.qualified` | `fund:<qualId>` |
| payout debit | `approvePayout` (single DEBIT) | `payout_ledger` unique (request, entry_type) |
| certificate | `recognition.ts` subscriber | `(organizationId, dedupeKey)` |
| support ticket | `submitTicket` | — |
| affiliate application | `submitApplication` | per-user dedup (409 ALREADY_APPLIED) |

## Read consumers

Portal (`/api/v1/portal/*`), Atlas (`/api/v1/accounts`, owner-scoped), Owner OS
(`/api/v1/admin/ops/*`), integrity/reconciliation — all read the SAME authoritative
tables. There is no parallel frontend store of business truth.
