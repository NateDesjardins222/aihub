# Commerce, Entitlements & Automatic Provisioning — V1

The path from a **server-verified** payment to a provisioned Atlas account, and
from an authoritative pass to a funded account — automatic, exactly-once, gated
on identity, and recoverable when anything fails after the money lands. This is
the milestone's spine and its hardest safety property.

> **THE BROWSER PAYMENT SUCCESS SCREEN MUST NEVER PROVISION A TRADING ACCOUNT.**
> Nothing a browser can say — `?success=true`, a client callback, a redirect URL,
> `localStorage`, frontend state, or a client-reported payment status — creates,
> activates, or funds an account. **Only an authenticated, signature-verified,
> server-side commerce event** authorises entitlement and provisioning. This is
> enforced structurally: the only code path that grants an entitlement is the
> commerce funnel, which is reachable only from the verified-webhook route and
> admin/RBAC doors — never from an unauthenticated success redirect.

> **No real provider is connected.** No Whop production credentials, no Stripe,
> no bank rails. `MockCommerceProvider` is the working default; the Whop adapter
> reports `unconfigured` without a webhook secret. Passing the mock flow is
> **not** evidence of a real payment integration.

This document is the contract for checkpoints E, F, G, H. It builds directly on
the existing, mapped commerce lifecycle and **extends** it — it does not fork it.

---

## 1. What already exists (reused, not rebuilt)

The Explore of `apps/server/src/platform/commerce.ts` established the one
authoritative funnel, which V1 extends in place:

```
createPendingOrder                          (schema commercial_orders, PENDING)
   └─[Whop webhook: verify → parse]→ fulfillOrder            (PENDING→COMPLETED, FOR UPDATE)
        └─ fulfillCompletedOrder  ← THE SINGLE FUNNEL (private)
             ├─ grantEntitlement(EVALUATION)                 (unique [orderId,kind])
             └─ provisionFromEntitlement                     (provisionAccount, key ent:<id>)
   … trading …
   account.passed ─[registerAutoCertification]→ certifyEvaluation  (qualification ELIGIBLE)
   … today: MANUAL approveFunding → FUNDED_SIM
```

Reused unchanged:

| Concern | Source |
| --- | --- |
| Order/entitlement/qualification tables & states | `commercial_orders`, `entitlements`, `account_qualifications` (`schema.ts:411-525`) |
| Order idempotency | unique `(organizationId, idempotencyKey)`; `FOR UPDATE` + `PENDING→COMPLETED` guard |
| Entitlement idempotency | unique `(commercialOrderId, kind)` |
| Provisioning idempotency | `provisioning_requests` unique `(organizationId, idempotencyKey)`, key `ent:<id>` / `fund:<qualId>` |
| Whop signature + parse | `whop.ts` `whopConfigured / verifyStandardWebhook / parseWhopEvent` |
| Sandbox checkout | `whop-client.ts` `SandboxWhopClient.createCheckoutSession` |
| Certify (pass→ELIGIBLE) | `commerce.ts certifyEvaluation`, `commerce-certify.ts registerAutoCertification` |
| Funded provisioning | `commerce.ts approveFunding` (locked, idempotent `fund:<qualId>`) |
| Immutable product versions | `account_profile_versions.config` (`profiles.ts`) |
| Audit / events / outbox | `audit.ts` / `events.ts` / `outbox.ts` |

Two facts from the map drive the whole design:

1. **A completed purchase provisions an evaluation immediately, with no identity
   or agreements gate.** V1 inserts that gate at the single funnel.
2. **A pass does not auto-fund.** `certifyEvaluation` stops at an `ELIGIBLE`
   qualification; funding is a manual admin call. V1 adds an automatic,
   config-gated `evaluation.qualified → approveFunding` subscriber + sweep,
   reusing the existing locked idempotent `approveFunding` **unchanged**.

---

## 2. The 10 locked products (immutable configuration, not hard-coded)

Product terms live where they already live: immutable `account_profile_versions`
rows, resolved by key, with the commercial fields already in `ProfileConfig`
(`payoutRules`, `fundedDestinationKey`, `whopPlanId`). V1 seeds/verifies exactly
these ten evaluation products (each maps to a funded destination version):

| Line | Size | Price | Key (evaluation) |
| --- | --- | --- | --- |
| Core | 25K | $65 | `htf-core-25k` |
| Core | 50K | $95 | `htf-core-50k` |
| Core | 100K | $170 | `htf-core-100k` |
| Core (Gold) | 300K | $599 | `htf-core-300k` |
| Select | 25K | $85 | `htf-select-25k` |
| Select | 50K | $135 | `htf-select-50k` |
| Select | 100K | $230 | `htf-select-100k` |
| Daily | 25K | $90 | `htf-daily-25k` |
| Daily | 50K | $145 | `htf-daily-50k` |
| Daily | 100K | $250 | `htf-daily-100k` |

- `payoutRules` per line already match the payout engine (Core 50% eval
  consistency; Select/Daily 40% eval consistency; Select 40% funded consistency;
  Daily buffers $1000/$2000/$4000; all 90% split; $0 activation; 5 winning days
  ≥ $150). No 150K/200K.
- Price/currency are `amountMicros`/`currency` on the order; **an external
  provider amount never silently becomes an Atlas balance** — the account's
  starting balance comes from the product version's `display.startingBalanceMicros`,
  and the order amount is validated against the product's expected price (§7).
- `whopPlanId` on the version is the mapping to the Whop plan; a missing/unknown
  mapping is an owner exception (§9), never a guess.

Seeding is idempotent (publish-if-absent, like `seed-htf-payout.ts`).

---

## 3. CommerceProvider abstraction

The domain must not spread Whop assumptions. It speaks to an interface with a
deterministic mock (the working default) and a Whop adapter that wraps the
existing `whop.ts`/`whop-client.ts` and reports `unconfigured` without a secret.

```ts
export interface CommerceProvider {
  readonly name: 'MOCK' | 'WHOP';
  isConfigured(): boolean;

  /** Build the config the embedded checkout surface needs (plan, metadata). */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutConfig>;

  /** Verify authenticity of an inbound event (signature, timestamp). Never throws. */
  verifyEvent(raw: RawCommerceEvent): CommerceEventVerification;

  /** Normalise a verified event into the domain's vocabulary. */
  normalizeEvent(raw: RawCommerceEvent): NormalizedCommerceEvent;
}
```

`NormalizedCommerceEvent` is the provider-neutral shape the funnel consumes:

```ts
type CommerceEventKind =
  | 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED'
  | 'REFUND' | 'DISPUTE_OPENED' | 'DISPUTE_CLOSED'
  | 'UNKNOWN';
interface NormalizedCommerceEvent {
  providerEventId: string;        // the provider's unique event id (dedup key)
  kind: CommerceEventKind;
  atlasOrderId: string | null;    // from metadata, never from a redirect
  providerCustomerId: string | null;
  receiptId: string | null;
  amountMicros: number | null;
  currency: string | null;
  occurredAt: Date | null;
  raw: unknown;                    // kept only for the audited event record
}
```

- **`WhopCommerceProvider`** wraps `verifyStandardWebhook` (signature +
  timestamp tolerance), `parseWhopEvent`, and `createCheckoutSession`. Extends the
  parse to surface refund/dispute event types and the provider event id
  (`webhook-id` header) — today's `parseWhopEvent` only surfaces `payment.succeeded`.
  `isConfigured()` = `whopConfigured()`.
- **`MockCommerceProvider`** is deterministic: `verifyEvent` accepts a
  locally-minted HMAC (a fixed dev secret) so the browser harness and tests can
  post a *server-side* event that is genuinely verified — proving the security
  property without a real provider. It emits any `CommerceEventKind` on demand.
- Selection: `commerceProviderFromEnv()` → Whop when configured, else Mock;
  surfaced to the owner as `commerce: 'mock' | 'whop'`.

---

## 4. Commerce event authenticity, dedup & replay (`commerce_events`)

Today idempotency is entirely downstream (order-level). V1 adds a **first-class
event ledger** so authenticity, uniqueness, replay, and ordering are explicit and
auditable — the section-38 chaos cases demand it.

`commerce_events` table:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `provider` | varchar(16) | `MOCK｜WHOP` |
| `provider_event_id` | varchar(200) | the provider's event id |
| `kind` | varchar(24) | normalized kind |
| `atlas_order_id` | uuid FK → commercial_orders, nullable | |
| `status` | varchar(16) | `RECEIVED｜PROCESSED｜IGNORED｜REJECTED｜FAILED` |
| `signature_ok` | boolean | |
| `reject_reason` | varchar(48), nullable | `BAD_SIGNATURE｜STALE｜MALFORMED｜UNKNOWN_ORDER｜UNKNOWN_PRODUCT` |
| `payload_digest` | varchar(64) | sha256 of raw body (no secrets) |
| `received_at` / `processed_at` | timestamptz | |

Unique: `(provider, provider_event_id)` — **the structural dedup**. The webhook
handler:

1. `verifyEvent` → on failure insert a `REJECTED`(`BAD_SIGNATURE`/`STALE`) row and
   return 401 (no processing).
2. `normalizeEvent` → on malformed insert `REJECTED`(`MALFORMED`) → 400.
3. Insert `commerce_events` with `onConflictDoNothing` on `(provider,
   provider_event_id)`. **If the row already exists → this is a duplicate/replay;
   ack 200 and stop** (no second provision). This makes a 10×-delivered webhook
   harmless at the event layer, on top of the existing order-level guard.
4. Route by `kind` (§5–§8), then mark the event `PROCESSED`/`IGNORED`/`FAILED`.

Out-of-order handling: the order/qualification state machines are guarded by
status (`WHERE status = expected`), so a late/duplicate event converges rather
than corrupts. An event for an `UNKNOWN` product mapping or unknown order is
recorded `REJECTED`/`FAILED` and raised as an owner exception — **never silently
dropped** (reconciliation, §10).

---

## 5. `PAYMENT_SUCCEEDED` → gated automatic evaluation provisioning

This is the core flow, and where the identity/agreements gate is inserted.

### 5.1 The seam

The gate goes at **`fulfillCompletedOrder`** (`commerce.ts:311-331`) — the single
funnel every paid/granted account passes through, so one gate covers webhook +
admin-grant + tests. The webhook route stays as thin as today (verify → parse →
`fulfillOrder`); the order is always durably `COMPLETED` first, so the payment is
never lost even when provisioning is deferred.

### 5.2 The gate

Before `grantEntitlement`/`provisionFromEntitlement`, resolve the customer
identity for `(order.organizationId, order.userId)` and call
`evaluateProvisioningGate` (defined in `customer-identity-v1.md` §9):

- **Gate satisfied** (`identityOk && contactOk && agreementsOk`): proceed exactly
  as today → entitlement (unique per order+kind) → `provisionAccount` (key
  `ent:<id>`) → one ACTIVE evaluation. Emit `entitlement.provisioned`. Fast path,
  no artificial manual approval.
- **Gate not satisfied:** do **not** provision. Move the order to a new,
  recoverable status **`PROVISION_BLOCKED`** and write the blocked reasons. The
  payment is preserved (order stays `COMPLETED`-equivalent in money terms — see
  status note below), nothing is lost, and the customer/owner both see
  "PAYMENT RECEIVED / PROVISIONING BLOCKED — identity/agreements incomplete".

### 5.3 Order status extension

`commercial_orders.status` is extended (the column comment already reserves room)
with two provisioning-outcome states that sit **after** money success:

```
PENDING → COMPLETED → (gate) → PROVISIONED
                              ↘ PROVISION_BLOCKED   (gate failed; recoverable)
                              ↘ PROVISION_FAILED    (provisioning threw after payment; recoverable)
```

- `COMPLETED` continues to mean "money settled server-side" (unchanged for
  existing rows). `PROVISIONED` is set once an account exists.
- `PROVISION_BLOCKED` / `PROVISION_FAILED` are the **"PAYMENT SUCCEEDED /
  PROVISIONING FAILED"** owner-exception states. Both carry a `provision_note`
  (added column) and are re-drivable.

### 5.4 Recovery (never lose a purchase)

- A **startup + periodic sweep** (mirroring `certifyPassedEvaluations`) re-runs
  `fulfillCompletedOrder` for orders in `COMPLETED`/`PROVISION_BLOCKED`/
  `PROVISION_FAILED` whose gate now clears. Because entitlement + provisioning are
  idempotent, re-running converges to **exactly one** account.
- The moment a customer's identity/agreements clear, an
  `identity.verified`/`agreement.accepted` subscriber nudges the sweep for that
  user's blocked orders — so a normal customer who completes identity right after
  paying is provisioned promptly without an operator.
- An **owner action** "Retry provisioning" (RBAC + reason + audit) re-drives one
  order safely.

### 5.5 Provisioning failure after payment

If `provisionFromEntitlement` throws (transient DB, etc.) *after* the order is
`COMPLETED`, the funnel catches, sets `PROVISION_FAILED` + note, emits
`entitlement.provisioning_failed`, and returns — **the money success is retained**.
The sweep/owner retry re-drives it; the `ent:<id>` idempotency key guarantees no
duplicate account.

---

## 6. Exactly-once, structurally

Duplicate/concurrent payment events must never yield two evaluations. The guards,
top to bottom:

1. **Event layer:** `commerce_events` unique `(provider, provider_event_id)` — a
   replayed webhook is dropped before any work.
2. **Order layer:** `fulfillOrder` `SELECT … FOR UPDATE` + `PENDING→COMPLETED`
   guard — only one caller flips the order.
3. **Entitlement layer:** unique `(commercialOrderId, kind)` — one entitlement per
   order+kind.
4. **Provisioning layer:** `provisioning_requests` unique `(organizationId,
   idempotencyKey=ent:<id>)` — one account per entitlement.

Ten concurrent copies of a payment event → one account. This is asserted directly
in the concurrency/chaos tests (checkpoint L).

---

## 7. Money & mapping validation

- **Integer micros only**, no floats. `amountMicros`/`currency` on the order.
- On a `PAYMENT_SUCCEEDED` the funnel validates the normalized event against the
  order's product version: expected `whopPlanId`, expected price
  (`amountMicros`), and currency. A mismatch is recorded on the `commerce_events`
  row and raised as an owner exception (`UNKNOWN_PRODUCT`/`PRICE_MISMATCH`) — it
  does **not** silently provision.
- The provider amount is **never** copied into a balance; the starting balance is
  the product version's configured value. Money invariants (order amount vs
  product price; refund amount ≤ order amount) reconcile in tests.

---

## 8. `evaluation.qualified` → automatic funded provisioning (pass → funded)

The rule engine and `certifyEvaluation` stay authoritative — V1 does **not**
recreate pass/fail math. It adds the missing automation.

### 8.1 The subscriber

`registerAutoFunding(db)` subscribes to the event bus; on
`type === 'evaluation.qualified'` with a `qualificationId`, it calls
`approveFunding(db, qualificationId)` (config-gated by `HTF_AUTO_FUNDING`,
default on for this milestone). It is a **bystander** — a failure never fails the
certify/trade. Registered next to `registerAutoCertification` in `app.ts`.

- It does **not** run inside `certifyEvaluation`'s transaction (no nesting of two
  one-way transitions under the certify lock). It reacts to the committed event.

### 8.2 Startup + periodic sweep

`fundEligibleQualifications(db)` (mirroring `certifyPassedEvaluations`) finds
`account_qualifications` with `fundingState = 'ELIGIBLE'` and null
`fundedAccountId`, and calls `approveFunding` for each — the recovery net for a
missed event or a crash between certify and fund.

### 8.3 Exactly-once funded

`approveFunding` is already: `SELECT … FOR UPDATE` on the qualification, early
return if `fundedAccountId` set, provisioning key `fund:<qualId>`, unique
`(accountId, lifecycleId)` qualification. So a duplicate `evaluation.qualified`,
a concurrent auto+manual approve, or a restart mid-approve all converge to **one**
funded account. On success: funded account exists with the pinned
`fundedProfileVersionId` (immutable product), dashboard updates (via the existing
`account.funded` event + read model), and a `FUNDED_READY` notification is
enqueued (async, never blocking) — see `notifications-v1.md`.

A normal customer does **not** wait for an employee to pass → funded.

---

## 9. Refunds & disputes (explicit state, never a history rewrite)

Historical truth is preserved: purchases and accounts are **never deleted**.

### 9.1 Refund (`REFUND` event)

- Records the refund on the `commercial_orders` row: status → `REFUNDED`, with a
  `refunded_at`/`refund_reason`. The behaviour on the produced account depends on
  lifecycle state:
  - not yet provisioned / blocked → mark the entitlement `REVOKED`; no account
    ever existed to touch.
  - provisioned evaluation, not yet funded → the entitlement is `CONSUMED`
    (history stays); the account is placed on an owner-reviewable **hold**
    (`adminHold`), not deleted. Owner decides disable vs keep.
  - funded → refund is unusual; recorded, funded account placed on hold, raised as
    an owner **Refund Review** exception. No auto-confiscation.
- All via a compensating transition + audit + `commerce.refunded` event. No row is
  overwritten destructively.

### 9.2 Dispute / chargeback (`DISPUTE_OPENED`/`_CLOSED`)

- A dispute is a **commerce risk event**, not a history rewrite. It creates/updates
  a risk record, places trading/payout **restrictions** (hold) on the linked
  accounts, audits, and raises a **Dispute/Chargeback** owner exception for real
  review. `DISPUTE_CLOSED` (won) releases the hold; (lost) keeps it for owner
  resolution.
- **No auto-confiscation and no permanent ban on a single dispute** — aggressive
  containment (hold the money movement), conservative accusation (owner review,
  appealable). Consistent with the fraud philosophy.

---

## 10. Reconciliation (a payment must never silently disappear)

An owner-facing reconciliation view (checkpoint J) compares, per org and window:

- provider-reported `PAYMENT_SUCCEEDED` events (`commerce_events`) vs.
- `commercial_orders` (PENDING/COMPLETED/PROVISIONED/BLOCKED/FAILED/REFUNDED) vs.
- `entitlements` vs. provisioned evaluation accounts vs. funded accounts vs.
  refunds/disputes.

Discrepancies surface as rows: **UNPROCESSED COMMERCE EVENT** (received, not
processed), **PAYMENT SUCCEEDED / PROVISIONING FAILED**, **UNKNOWN PRODUCT
MAPPING**, **ORPHANED ENTITLEMENT** (granted, never consumed, no block reason).
Every dangling payment is visible and re-drivable; nothing is lost between Whop
and Atlas.

---

## 11. Domain events & audit added

**Domain events** (added to `DomainEventType`):

```
commerce.event_received
commerce.event_rejected
entitlement.provisioned
entitlement.provisioning_blocked
entitlement.provisioning_failed
commerce.refunded
commerce.dispute_opened
commerce.dispute_closed
```

(`evaluation.qualified`, `funding.approved`, `account.funded`, `entitlement.*`
already exist and are reused for the pass→funded automation.)

**Audit** (`AuditSubject` extended with `COMMERCE`): every funnel decision
(provisioned / blocked / failed / refunded / disputed / auto-funded) writes a
`recordAudit` with actor, before/after, and reason.

---

## 12. HTTP surfaces

- **Webhook** `POST /api/v1/commerce/whop` (existing, hardened): raw-body capture,
  rate-limited, `whopConfigured` gate, verify → `commerce_events` dedup → route.
  A parallel **`POST /api/v1/commerce/mock-event`** exists **only** in
  non-production (gated like the dev seeds) so the harness can post a genuinely
  server-verified mock event — it is still signature-checked by the mock provider,
  so it does not weaken the security property.
- **Checkout** `POST /api/v1/commerce/checkout` (existing): `requireUser`, resolve
  product (EVALUATION only), `createPendingOrder`, return the embedded checkout
  config; when no provider is configured returns `{configured:false}` and the
  order remains fulfillable by an admin/mock event later.
- **Customer status** `GET /api/v1/commerce/orders/:id/status` (new): returns the
  **server** state (`PENDING｜COMPLETED｜PROVISIONED｜PROVISION_BLOCKED｜
  PROVISION_FAILED｜REFUNDED`) and, when provisioned, the account id. The onboarding
  UI polls this; it is the **only** source the "Account Ready" screen trusts — the
  browser never reads readiness from the checkout success callback.
- **Owner** routes under `/api/v1/admin` for the exception queues, retry, mapping
  resolution, refund/dispute review, reconciliation (RBAC-gated, reason+audit).

---

## 13. Concurrency & idempotency summary

| Race | Guard |
| --- | --- |
| Duplicate webhook (same event id) | `commerce_events` unique `(provider, provider_event_id)` |
| Two concurrent webhooks (same order) | order `FOR UPDATE` + `PENDING→COMPLETED` |
| Repeated entitlement grant | unique `(commercialOrderId, kind)` |
| Repeated provisioning | `provisioning_requests` unique key `ent:<id>` |
| Duplicate pass event | `certifyEvaluation` idempotent per lifecycle; qualification unique `(accountId, lifecycleId)` |
| Concurrent auto+manual funding | `approveFunding` `FOR UPDATE` + early-return + key `fund:<qualId>` |
| Crash after payment, before provision | order durable; sweep/retry re-drives idempotently |
| Crash after provision, before marking event | `commerce_events` re-processed idempotently; account already exists (`reused:true`) |

---

## 14. Browser acceptance plan (this doc's slice of section 40)

Against the mock provider, driven by the harness:

1. Select a seeded product → `createCheckout` returns a mock embedded config.
2. **Client "success" does nothing:** simulate the checkout success screen; assert
   **no** account/entitlement is created from it (only a `PENDING` order exists).
3. Post a **server-side** mock `PAYMENT_SUCCEEDED` event (signature-verified) →
   `commerce_events` row `PROCESSED`, order `PROVISIONED`, exactly one evaluation
   account in Atlas.
4. Re-post the **same** event → no duplicate account (event deduped).
5. Force an authoritative pass (existing engine path) → `evaluation.qualified` →
   funded account auto-created **exactly once**; re-fire the pass event → no
   duplicate funded.
6. With identity/agreements incomplete, a `PAYMENT_SUCCEEDED` parks the order
   `PROVISION_BLOCKED` (no account); completing identity + a sweep provisions it
   once.
7. Owner console shows the full lifecycle (order → event → entitlement → eval →
   qualification → funded), and the reconciliation view is clean.

Screenshots + JSON artifact via `createReport`.

---

## 15. Explicitly not built (this doc)

Real Whop production credentials/live payments, real card/bank processing, tax
reporting, affiliate/coupon logic, real dispute adjudication with a provider,
partial-refund proration math beyond `amount ≤ order`. All are seams or
owner-reviewed states, clearly labelled; the mock is the working default and is
never presented as a live integration.
