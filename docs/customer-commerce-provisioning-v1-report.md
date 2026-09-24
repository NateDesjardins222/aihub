# Customer Identity + Whop Commerce + Automatic Provisioning V1 — completion report

The platform is now structurally capable of taking a human from
VISITOR → Happy Trader account → verified contact → verified identity →
agreements accepted → product selected → checkout → **server-verified** payment →
entitlement → auto-provisioned evaluation → authoritative pass → auto-provisioned
funded account → dashboard/notifications — with every money- and account-moving
step server-authoritative, idempotent, concurrency-safe, audited, and recoverable.

> **No real provider is connected.** No Whop production credentials, Stripe
> Identity, Resend, or Twilio are wired. The mock/local adapters are the working
> default; the production adapters are seams that report themselves *unconfigured*
> and never fabricate a verification, a payment, or a delivery. Passing the mock
> flow is **not** evidence any production integration exists. See §19.

---

## 1. Starting & final HEAD

- **Starting HEAD:** `2d8a272` (payout-engine-v1 completion report).
- **Final HEAD:** `8b594f0` (+ this report commit).
- **Branch:** `claude/futures-trading-simulator-v8qefu`.

## 2. Commits created (11, doc-first)

```
f68f2db docs(htf): three V1 design docs (doc-first, before implementation)
96b81f7 feat(htf): schema + migration 0018
58f6924 feat(htf): customer identity domain + contact/identity verification + provider seams
9d148fd feat(htf): versioned agreements + immutable acceptance + provisioning gate
2673aea feat(htf): CommerceProvider abstraction + mock/Whop adapters + commerce_events dedup
bb17030 feat(htf): gated auto evaluation provisioning + recoverable parking + refunds/disputes
e674473 feat(htf): automatic pass -> funded (evaluation.qualified subscriber + sweep)
25386b0 feat(htf): async customer notifications — providers, worker, idempotency
e2dca3f feat(htf): owner Customer/Commerce console — 360, exception queues, reconciliation
361adc9 feat(htf): customer onboarding flow + checkout surface + 10 product catalog
8b594f0 test(htf): chaos/concurrency invariants
```

## 3. Docs created

- `docs/customer-identity-v1.md` — identity spine, contact/identity verification,
  provider abstraction, versioned agreements, the gate predicate.
- `docs/commerce-provisioning-v1.md` — CommerceProvider abstraction, event
  dedup/replay, the browser-cannot-provision property, gated auto provisioning
  with recoverable states, pass→funded, refunds/disputes, reconciliation.
- `docs/notifications-v1.md` — async Email/SMS, idempotency, worker off the
  critical path.
- `docs/customer-commerce-provisioning-v1-report.md` — this report.

## 4. Migration & schema changes

`apps/server/drizzle/0018_customer_identity.sql` (journal entry 18), applied to
`atlas` and `atlas_test`. Additive and non-destructive. New tables:
`customer_identities`, `verified_contacts`, `contact_verification_challenges`,
`identity_verifications`, `agreement_versions` (append-only trigger),
`agreement_acceptances` (append-only trigger), `commerce_events`,
`notification_messages`. `commercial_orders.status` widened to varchar(24) with
`provision_note` / `refunded_at` / `refund_reason` added. `profiles.ts` display
config gains optional `priceMicros`. FKs, unique constraints (the structural
idempotency guards), indexes, and a partial-unique "one primary contact per
channel".

## 5. Customer identity ("email is not the person")

`customer_identities` is the permanent spine, one per auth user (unique
`user_id`), keyed by id — never by email. It links user/contacts/verifications/
agreements/orders/entitlements/accounts/notifications/audit. A guarded state
machine (`customer-identity.ts`, `identity-lock.ts`) moves `identity_status`
UNVERIFIED → CONTACT_PENDING → CONTACT_VERIFIED → IDENTITY_PENDING →
{STEP_UP_REQUIRED｜UNDER_REVIEW} → IDENTITY_VERIFIED｜REJECTED under a dedicated
advisory lock + `FOR UPDATE`, refusing illegal transitions.

## 6. Contact verification

`contact-verification.ts`: email/phone challenges with salted-hash codes only
(never stored or returned in prod), 10-min TTL, attempt cap (the increment
commits even on a rejected attempt so the brute-force guard actually trips),
replay/expiry inert. Both primary channels verified → `CONTACT_VERIFIED`.

## 7. Identity verification (provider abstraction)

`IdentityVerificationProvider` (`identity-providers.ts`) with a deterministic
`MockIdentityProvider` (decision encoded in the ref, stateless) and a
`StripeIdentityProvider` seam that reports unconfigured and never fakes a
verified result. `identity-verification.ts` drives the state machine through the
provider (start requires contact; resolve is idempotent; owner reverification and
review decisions are audited). HOLD/UNDER_REVIEW is not a conviction; REJECTED is
appealable. No SSN/TIN, no country eligibility gate, no document images.

## 8. Agreements

`agreements.ts`: versioned `agreement_versions` (append-only, idempotent on
content hash, DEV PLACEHOLDER content explicitly labelled) + immutable
`agreement_acceptances` (unique per identity+version). `outstandingAgreements`
drives the gate; a new required version reopens it.

## 9. The provisioning gate

`provisioning-gate.ts` `evaluateProvisioningGate` — a single read-only predicate:
`identityOk (IDENTITY_VERIFIED) && contactOk (live primary email + phone) &&
agreementsOk (nothing outstanding)`. The only coupling between identity and the
commerce/trading authority; it never provisions.

## 10. Commerce provider abstraction + event dedup

`commerce-provider.ts`: `CommerceProvider` (createCheckout / verifyEvent /
normalizeEvent) with a deterministic `MockCommerceProvider` (Standard-Webhooks
verification with a fixed dev secret so tests/harness can post a *genuinely
verified* server-side event) and a `WhopCommerceProvider` wrapping the existing
`whop.ts`/`whop-client.ts`, reporting unconfigured without a secret.
`commerce-events.ts`: the authenticity + dedup ledger — unique
`(provider, provider_event_id)` drops a replay before any work; a bad signature
is RECORDED as REJECTED (never dropped) keyed off the payload digest so a forged
webhook-id cannot poison a real event's dedup slot.

## 11. THE browser-cannot-provision property (structurally enforced)

The only code path that grants an entitlement is the commerce funnel, reachable
only from the **signature-verified** webhook route (`/api/v1/webhooks/{whop,mock}`)
and RBAC admin doors. The onboarding UI's "Account Ready" screen is driven
**entirely** by `GET /api/v1/commerce/orders/:id/status`, never by a checkout
callback. Proven in the browser acceptance (a checkout order stays PENDING with
no account until a verified server event arrives) and in
`commerce-fulfillment.test.ts` / `onboarding.routes.test.ts`.

## 12. Gated automatic evaluation provisioning + recovery

`commerce.ts` split into `markOrderCompleted` (money flip) and
`fulfillCompletedOrder` (the single funnel). `commerce-fulfillment.ts` inserts the
gate: a paid PURCHASE order provisions only when the gate is satisfied; otherwise
it parks recoverably in `PROVISION_BLOCKED` (payment retained). A provisioning
error parks `PROVISION_FAILED`. `retryPendingProvisioning` (startup sweep) + a
deferred `identity.verified`/`agreement.accepted` recovery subscriber re-drive
blocked orders idempotently → exactly one account. ADMIN_GRANT bypasses the gate.

## 13. Automatic pass → funded

`commerce-certify.ts` adds `registerAutoFunding` (subscribes to
`evaluation.qualified` → the existing idempotent locked `approveFunding`,
config-gated by `HTF_AUTO_FUNDING`, default on) + `fundEligibleQualifications`
startup sweep. The rule engine and `certifyEvaluation` stay authoritative; no
pass/fail math is recreated. Exactly-once funded is guaranteed by
`approveFunding`'s `FOR UPDATE` + early-return + `fund:<qualId>` key. A normal
customer is funded without an employee.

**Deadlock lesson (applied throughout):** subscribers that do org-audit-locked DB
work must defer it off the publishing call stack — the event fires inside the
caller's audit-locked transaction, so synchronous work would deadlock on the
per-org audit advisory lock. The recovery, auto-funding, and notification
subscribers all `setTimeout(0)` their work as bystanders.

## 14. Refunds & disputes

`commerce-refund.ts`: explicit state, never a history rewrite. Refund → order
REFUNDED + unconsumed entitlement REVOKED or produced account held for owner
review. Dispute → containment hold on the linked account + owner review, no
auto-confiscation, no permanent ban on one dispute.

## 15. Async notifications

`notification-providers.ts` (Email/SMS interfaces; Mock default; Resend/Twilio
seams that SUPPRESS rather than fake). `notifications.ts`: ~19 types + channel
policy (SMS reserved for verification/milestones/payout/security);
`enqueueNotification` at-most-once per `(org, dedupe_key)`; a deferred event
consumer records intents; a worker delivers with retry/backoff and marks
SENT/SUPPRESSED/FAILED. Trading/payment/provisioning never wait on a provider.

## 16. Owner Customer/Commerce console

`owner-customer.ts` + `routes/customers.ts` + web `CustomersPage` (extends the
existing /admin, no second app): customer search → 360 (identity, contacts,
agreements, orders, entitlements, accounts, notifications, audit, active provider
names); exception queues (identity review, provisioning exceptions =
PAYMENT SUCCEEDED/PROVISIONING FAILED, unprocessed commerce events, disputes,
refunds, notification failures, orphaned entitlements) with counts;
reconciliation (provider payment events vs orders/entitlements/accounts — a
received-not-processed payment is surfaced as unreconciled). SUPPORT reads; ADMIN
acts (retry provisioning, require reverification, resolve review, place/release
hold, resend notification) — reason-required + audited.

## 17. Customer onboarding UI + 10 products

`scripts/seed-htf-products.ts` seeds the 10 LOCKED products (Core 25/50/100/300
Gold, Select 25/50/100, Daily 25/50/100) in immutable config with prices,
payoutRules matching the payout engine, funded destinations, and whopPlanIds.
`routes/onboarding.ts` (`/api/v1/onboarding`) is the customer-facing flow; the web
`OnboardingApp` (lazy `/onboarding` bundle) walks contact → identity → agreements
→ product select → mock checkout surface → server-state-driven processing ladder →
Account Ready. Premium black/chrome/gold, DM Sans, responsive, reduced-motion.

## 18. APIs / routes added

- Customer: `/api/v1/onboarding/{state, contact/start, contact/confirm,
  identity/start, identity/resolve, agreements, agreements/accept, products,
  dev/simulate-payment (non-prod)}`; `/api/v1/commerce/orders/:id/status`.
- Webhooks: `/api/v1/webhooks/whop` (hardened through the provider + dedup),
  `/api/v1/webhooks/mock` (non-prod).
- Owner: `/api/v1/admin/customers[...]` (search, 360, exceptions, reconciliation,
  seven queues, and five reason-gated actions).

## 19. Tests

**Server unit/integration/property/concurrency — 100/100 across 13 new files:**
`customer-identity.test.ts`, `identity-verification.test.ts`,
`agreements.test.ts`, `commerce-provider.test.ts`, `commerce-fulfillment.test.ts`,
`commerce-funding.test.ts`, `commerce-chaos.test.ts`, `notifications.test.ts`,
`customers.routes.test.ts`, `onboarding.routes.test.ts` (+ existing
`commerce.test.ts`, `commerce-whop.test.ts` updated to the gated reality,
`env.test.ts`). Coverage includes: the identity state machine (pure + illegal
transitions + idempotent/concurrent creation), contact brute-force/replay,
identity verified/review/reject/idempotent, agreement immutability + gate,
signature verify/tamper/stale, **10 concurrent identical events → one ACCEPTED**,
gate block → sweep → **exactly-once** account, **10 concurrent fulfilments → one
account**, payment-then-crash recovery, exactly-once funded under concurrency,
notification idempotency/suppression/retry→FAILED and the account.funded consumer
producing one FUNDED_READY per channel from duplicate events, and full RBAC/IDOR
on the console and onboarding routes.

**Concurrency/invariant highlights** (`commerce-chaos.test.ts`, and within the
others): duplicate payment event harmless; ten concurrent copies → one account;
payment-then-crash-before-provision recovered exactly once; duplicate pass /
concurrent funding → one funded account.

## 20. Browser acceptance (real browser, dev stack) — 14/14

`tests/browser/commerce-acceptance.spec.mjs`: gate satisfied via identity +
contact + agreements; onboarding UI shows the 10-product catalog; a checkout
order is PENDING with **no account** (browser cannot provision); a verified
server-side event provisions the evaluation; the order becomes PROVISIONED with an
Atlas account; **a duplicate event makes no second account**; the branded mock
checkout surface renders; the server-state-driven processing screen reaches
Account Ready; the owner console shows reconciliation, search, the customer 360
with orders + notifications; **no console errors**. Screenshots in
`docs/artifacts/customer-commerce-v1/` (onboarding-select, checkout-surface,
account-ready, owner-360).

## 21. Validation status

- **Server typecheck:** clean. **Web typecheck:** clean.
- **Milestone test files:** 100/100 (13 files).
- **Full server suite:** the pre-existing `src/trading/*` DB-contention flakes
  (engine, determinism, adversarial, money-oracle, rules.integration,
  pnl-reconciliation) fail identically at the base commit `2d8a272` and pass in
  isolation (e.g. money-oracle 11/11 alone) — **not introduced by this
  milestone**. No milestone file is flaky.
- Clean tree; every checkpoint committed and pushed to the branch.

## 22. Known limitations / intentionally deferred

- Provider integrations are seams only (§ below). Mock/local is the working
  default and is never presented as production.
- The `dev/simulate-payment` and `/webhooks/mock` routes are non-production only.
- Agreement bodies are clearly-labelled DEV PLACEHOLDER text, not counsel-approved.
- pass→funded is proven by unit/integration tests (subscriber + sweep,
  exactly-once); the browser acceptance covers the eval-provisioning + owner
  lifecycle slice, not a live trade-to-pass (heavy) — that is exercised by the
  server tests and the existing engine suite.
- The broader trader-facing portal (dashboards, deep analytics, certificates,
  achievements, account-limit UX) is the **next** queued milestone, not this one.

## 23. External provider credentials still required (NOT connected)

- **Whop** production webhook secret + company API key (commerce).
- **Stripe Identity** secret key + identity webhook secret (KYC).
- **Resend** API key + from address (email).
- **Twilio** account SID + auth token + from number (SMS).

Each adapter's `isConfigured()` returns false today; the system reports the
unconfigured state honestly and does not silently pretend a real verification,
payment, or delivery occurred.

## 24. Recommended next milestone

The user has queued **Customer Portal + Trader Analytics + Account Lifecycle UX
V1** (dashboards, deep analytics, certificates, achievements, five-active-account
invariant, reset/refund UX, payout center UX, Atlas ↔ portal handoff). It builds
directly on this milestone's identity, commerce, entitlement, provisioning,
funding, notification, and owner-console architecture.
