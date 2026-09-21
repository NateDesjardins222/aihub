# Commercial Account Lifecycle V1 — autopsy and plan

Baseline `16ac242` (Professional Market Data V2 offline gate). Branch
`claude/futures-trading-simulator-v8qefu`. Databento is PAUSED and untouched.

This milestone connects existing systems into a real prop-firm account lifecycle:
**commercial order → entitlement → evaluation → pass/fail → funded eligibility →
funded account**. It processes NO real money. A future payment provider is
merely an authenticated trigger into this domain.

---

## 1. Autopsy — what already exists (do not rebuild)

| Concern | State | Where |
| --- | --- | --- |
| Idempotent provisioning (`provisionAccount` + `provisioningRequests`, hash-keyed) | **EXISTS** | `platform/provisioning.ts` |
| Machine provisioning seam (`x-api-key`, mandatory `Idempotency-Key`) | **EXISTS** | `http/routes/provisioning.ts` |
| Immutable versioned products + pinning (`accounts.profileVersionId`) | **EXISTS** | `platform/profiles.ts`, schema |
| Product deactivation (RETIRED blocks new, keeps existing) | **EXISTS** | `profiles.ts setProfileStatus` |
| Rule engine computes PASSED (target + min days + winning days + consistency) and FAILED/LOCKED | **EXISTS** | `packages/core/src/rules/rules.ts` |
| `account.passed` / `account.failed` durable events + `recordRuleOutcome` + lifecycle close | **EXISTS** | `platform/account-service.ts`, `engine-audit.ts` |
| `accountLifecycles` (per-account lives, endReason PASSED/FAILED/RESET/ARCHIVED) | **EXISTS** | schema |
| Operator actions (activate/lock/unlock/disable/enable/archive/reset) under advisory lock | **EXISTS** | `account-service.ts` |
| Order gate rejects non-tradeable status, incl. `ACCOUNT_PASSED` | **EXISTS** | `trading/risk.ts checkOrder` |
| Events / outbox / hash-chained audit / tenancy / roles | **EXISTS** | `platform/*` |

### PARTIAL / MUST CHANGE

- **PASSED is reversible.** The engine re-evaluates every mark; a PASSED account
  reverts to ACTIVE if profit is given back, and `canTrade` stays true
  (`rules.ts:361-395`). There is no frozen, irreversible qualification. **This
  milestone adds an explicit one-way certification.**
- **`accountType` is a free varchar**, only EVALUATION/PRACTICE seeded; FUNDED is
  a dormant string with no product, rules, or provisioning.

### MISSING (add)

CommercialOrder, Entitlement, an immutable **qualification snapshot**,
funded-eligibility + approval, a **funded account linked to its evaluation**, and
a **funded product-version relationship pinned at acquisition**.

### MUST NOT CHANGE

The execution engine's matching/fill/P&L/rule math, projections, reliability
spine (`338f832`), and Databento (paused). Contract identity and market-data
paths stay intact. New work is additive: new tables, a lifecycle service, and a
freeze that uses the order gate's **existing** `ACCOUNT_PASSED` rejection.

---

## 2. Domain model (minimum for correctness)

- **CommercialOrder** (`commercial_orders`): a provider-independent record that a
  customer acquired a product. `{id, organizationId, userId, productVersionId,
  source (ADMIN_GRANT|PURCHASE|…), externalProvider, externalReference, status
  (PENDING|COMPLETED|FAILED|CANCELLED|REFUNDED), amountMicros, currency,
  idempotencyKey, createdAt, completedAt}`. A future Stripe/Whop webhook creates
  and completes one of these; nothing downstream cares about the source.
- **Entitlement** (`entitlements`): the right, created by a COMPLETED order (or an
  admin grant), to receive one account. `{id, organizationId, userId,
  commercialOrderId?, productVersionId, kind (EVALUATION|RESET), source, status
  (GRANTED|CONSUMED|REVOKED), consumedByAccountId?, createdAt, consumedAt}`. One
  entitlement provisions **exactly one** account (idempotent consumption).
- **Qualification** (`account_qualifications`): the immutable evidence that an
  evaluation passed, plus the (separately mutable) funding lifecycle.
  Immutable part: `{id, org, accountId, lifecycleId, productVersionId, evidence
  jsonb (each requirement: label, required, actual, met), balanceMicros,
  qualifiedAt}`. Funding part: `{fundingState (ELIGIBLE|FUNDING_PENDING|APPROVED|
  DECLINED|FUNDED), fundedAccountId?, approvedByUserId?, approvedAt,
  declineReason?}`. Unique `(accountId, lifecycleId)` → certify exactly once.
- **Funded linkage**: `accounts.sourceQualificationId?` and
  `accounts.sourceAccountId?` (nullable) — a funded account points back to the
  evaluation it came from. Evaluation history is preserved, never mutated.
- **Funded product relationship**: the evaluation product's config gains
  `fundedDestinationKey?`. At **evaluation provision time**, that key is resolved
  to the funded product's then-current version and pinned onto the evaluation
  account as `fundedProfileVersionId?`. On funding approval, the funded account
  is provisioned against that exact pinned version — so a later owner change to
  the funded product does not alter an already-sold evaluation (Phase 50).

No entities are added for enterprise flavour; each is required by a phase.

---

## 3. State machine (evaluation account)

```
              provision (from entitlement)
  (none) ─────────────────────────────────► PENDING ──activate──► ACTIVE
                                                                     │
                          rule breach (drawdown/daily/max-days)      │ profit target + all
                          ┌──────────────────────────────────────┐  │ requirements met, day final
                          ▼                                        │  ▼
                        FAILED  (terminal)              ACTIVE ⇄ GOAL_REACHED
                          │                                        │  certify (server, one-way)
                          │                                        ▼
                          │                              PASSED + hold=QUALIFIED (terminal-good)
                          │                                        │  funding: ELIGIBLE
                          │                                        ▼  → FUNDING_PENDING → APPROVED
                          │                              funded account provisioned (FUNDED_SIM)
                          │                                        │  fundingState=FUNDED
  operator overlays: LOCKED (recoverable), DISABLED, ARCHIVED; RESET opens a new life.
```

- **Certification is one-way and server-authoritative.** Trigger: the durable
  `account.passed` event (auto) or an explicit `certifyEvaluation` service call
  (tests/owner). It re-checks authoritative rule state, then in one advisory-
  locked transaction: freezes the account (`status=PASSED`, `adminHold=QUALIFIED`
  so the reversible engine can't un-pass it — the order gate already rejects
  `PASSED` with `ACCOUNT_PASSED`), writes the immutable qualification snapshot,
  closes the lifecycle (endReason PASSED), and emits `evaluation.passed` +
  outbox + audit. Idempotent via the unique qualification row.
- **Failure** is already emitted by the engine (`account.failed`); this milestone
  records structured failure evidence on the qualification/lifecycle path and
  confirms the terminal-after-fail behaviour (checkOrder rejects `ACCOUNT_FAILED`).
- **Illegal transitions** (e.g. FAILED→PASSED, ARCHIVED→ACTIVE) are rejected
  deterministically by the transition `allowedFrom` guard + the certify pre-check.

---

## 4. Idempotency, transactions, reliability

- Order COMPLETED → Entitlement: one COMPLETED order yields one entitlement
  (unique on `commercialOrderId`).
- Entitlement → evaluation: `provisionAccount` idempotency key derived from the
  entitlement id; the entitlement's `consumedByAccountId` is the second guard.
  Retry / concurrency / restart never create two accounts.
- Certify → qualification: unique `(accountId, lifecycleId)`; concurrent/duplicate
  certify is a no-op returning the existing row.
- Approve funding → funded account: idempotency key derived from the qualification
  id; the qualification's `fundedAccountId` is the second guard. Double-click /
  concurrent owners / retry never create two funded accounts.
- All transitions write state + audit + domain event + outbox `account.changed`
  in one commit (the existing pattern). No dual-write.

## 5. Payment-provider seam (Phase 68, not implemented)

A future `POST /webhooks/<provider>` validates the provider event, then calls
`completeCommercialOrder(...)` → `grantEntitlement(...)` →
`provisionFromEntitlement(...)`. Nothing downstream knows Stripe existed. Payouts
attach later to the FUNDED lifecycle + outbox. **No payment/payout/KYC code is
written this milestone.**

## 6. Explicitly NOT built

Real payments, payouts, KYC/AML, checkout, promos, affiliates, revenue
dashboards, DOM/L2, chart/indicator features, authenticated Databento. Funded
accounts are `FUNDED_SIM` — never labelled live capital.
