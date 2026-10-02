# Pre-Whop Commerce Readiness — Phase 1 Report

**Phase:** Pre-Whop Commerce Readiness — Phase 1 (Purchase → Entitlement → Provisioning certification).
**Branch:** `claude/futures-trading-simulator-v8qefu`. **Starting commit:** `09d03c9`
(tag `pre-whop-commerce-readiness-phase1-start`). **Ending commit:** see final chat line.
**Companion docs:** `PRE_WHOP_COMMERCE_BOUNDARY_MAP.md`, `WHOP_INTEGRATION_READINESS_MATRIX.md`.

## Summary

The commerce → provisioning boundary was already strongly built (DB-backed idempotency, an advisory-lock active
cap guard, the RES-4 reset index, a provider-neutral `commerce_events` anti-corruption boundary, audited owner
retry, hash-chained audit, and extensive concurrency/crash/multi-instance tests). This phase mapped it from
code, repaired three real gaps at root cause, and documented the remainder as thin, well-defined Whop-phase
work. Whop was **not** integrated. No business rule changed; no product/price added.

**Repairs (root cause):**
- **GAP-A** — `provisionAccount` now takes a per-`(org, idempotency-key)` `pg_advisory_xact_lock` at the top of
  the creation transaction, closing the direct-caller double-provision window (the commerce/funding paths were
  already safe via a FOR UPDATE on the entitlement/qualification).
- **GAP-B** — the `PAYMENT_SUCCEEDED` handler now rejects a confirmed amount/currency that contradicts the order
  (`PRICE_MISMATCH`), while not blocking a provider that asserts no amount.
- **GAP-C** — two commerce-chain detectors added to the existing integrity framework
  (`ORDER_PROVISIONED_NO_ENTITLEMENT`, `ENTITLEMENT_CONSUMED_NO_ACCOUNT`).

## Commerce boundary map (classification)

- **Product:** `account_profiles` + immutable `account_profile_versions`; price `config.display.priceMicros`
  (informational). Pinned at order. **CONNECTED.**
- **Order:** `commercial_orders`, unique `(org, idempotencyKey)`, `FOR UPDATE` completion. **CONNECTED.**
- **Identity:** `users.id`, 1:1 & permanent with `customer_identities`. **PARTIAL** (documented; no change needed).
- **Entitlement:** `entitlements`, unique `(order, kind)`. **CONNECTED.**
- **Provisioning:** `provisionAccount`, advisory-locked + `provisioning_requests` key + FOR UPDATE on the
  entitlement. **CONNECTED (hardened this phase).**
- **Reset:** same path, kind `RESET`, RES-4 partial unique index, old account immutable. **CONNECTED.**
- **Reconciliation:** `runIntegrityChecks` + owner read-models + two new commerce-chain detectors.
  **CONNECTED (repaired).**
- **Portal:** `GET /portal/orders` real provenance. **CONNECTED.**
- **Owner OS:** Customer 360 + provisioning exception queue + audited retry. **CONNECTED** (minor UI gaps).

## Defects found & repaired

| ID | Severity | Root cause | Repair | Test |
|----|----------|------------|--------|------|
| GAP-A | P2 (contained: direct callers only; purchases already safe) | `provisionAccount` inserted the account before the `provisioning_requests` row with no per-key serialisation | per-`(org,key)` advisory lock + in-lock re-check (`provisioning.ts`) | `provisioning-idempotency.test.ts` (8 racers → 1 account; conflict rejected) |
| GAP-B | P2 (contained: signature-verified events today assert no amount) | no amount/currency consistency check; `PRICE_MISMATCH` unused | reject present mismatch in `PAYMENT_SUCCEEDED` (`http/routes/commerce.ts`) | `commerce-fulfillment.test.ts` (mismatch rejected; match provisions) |
| GAP-C | P2 (detection gap, no live impact) | `integrity:check` had no commerce-chain-break detectors | two P1 detectors in `resilience/integrity-checks.ts` | `commerce-integrity.test.ts` |

No P0/P1 defects were found or introduced.

## Provider-neutral contract

The internal boundary Whop will feed is `NormalizedCommerceEvent` (`commerce-provider.ts`), persisted into the
`commerce_events` table (unique `(provider, providerEventId)`), ahead of the unchanged provider-neutral domain.
The Whop adapter only authenticates + normalizes; nothing downstream depends on Whop JSON. (See the matrix.)

## Idempotency

- **event:** `commerce_events` unique `(provider, providerEventId)` + `onConflictDoNothing`.
- **order:** `commercial_orders` unique `(org, idempotencyKey)` + `FOR UPDATE` on completion.
- **entitlement:** `entitlements` unique `(commercialOrderId, kind)`.
- **account:** `FOR UPDATE` on the entitlement + `provisioning_requests` key + the new per-key advisory lock.
- **reset:** order key `reset:<failedId>` + entitlement unique + RES-4 partial unique `accounts_reset_of_key`.

## Concurrency (adversarial results)

- 8 concurrent identical-key **direct** `provisionAccount` → exactly one account (new, GAP-A).
- 10 concurrent fulfilments / distinct payment events for one order → one account (existing `commerce-chaos`).
- N concurrent enforced provisions at the cap boundary → never a sixth (existing `account-limit`,
  `resilience-races`, `multi-instance`).
- N concurrent resets of one failed account → one successor (existing; RES-4 fail-closed).
- Crash-after-order / crash-after-provision / response-loss retry → exactly one (existing `crash-recovery`).
- Multi-instance (separate pools, one DB) → cap, reset, funding all exactly-once (existing `multi-instance`).

## Account cap

`assertActiveSlotAvailable` takes a per-user `pg_advisory_xact_lock` inside the creation transaction, so the
count and insert are atomic; two concurrent purchases at 4 active produce one account + one recoverable park,
never a sixth. Proven by `account-limit.test.ts` and `multi-instance.test.ts`.

## Provenance

- **order → account:** `entitlements.commercialOrderId` → `entitlements.consumedByAccountId`
  (surfaced by `GET /portal/orders` and Customer 360).
- **account → order:** reverse of the same join.
- **product/version:** every account FKs a pinned `account_profile_versions.id`.

## Failure / recovery

A paid purchase that cannot provision parks as `PROVISION_BLOCKED`/`PROVISION_FAILED` (money kept), is visible
in the owner exception queue and the customer status endpoint, and is recoverable via the audited retry
(`fulfillPurchaseGated`) or the startup sweep (`retryPendingProvisioning`). No phantom or duplicate account; no
lost purchase.

## Owner operability

Customer 360 shows the order, product, amount, source, payment/provisioning state, provisionNote, resulting
account and hash-chained audit; the provisioning exception queue lists blocked/failed orders with an audited
"Retry provisioning" action. Ordinary failures need no SQL. (Minor: the web order table doesn't yet inline the
order↔product↔amount↔account correlation per row — documented, non-blocking.)

## Portal Billing

Truthful real-order provenance via `GET /portal/orders`; pending/failed states surface honestly; order → account
navigation present. No internal/provider debugging fields exposed.

## Security boundary

Only a signature-verified server-side event enters the `VerifiedCommerceEvent` boundary; a browser success
screen is inert (proven: `commerce-fulfillment.test.ts` "a pending order with no webhook never provisions").
The mock payment path is hard-gated to non-production (`MOCK_COMMERCE_FORBIDDEN`).

## Money precision

Integer micro-dollars (`bigint`) throughout commerce; no floating-point money comparison. Amount consistency
compares integers exactly.

## Reconciliation

`runIntegrityChecks` now detects: active-cap over-cap, duplicate funded/reset successor, and (new) a PROVISIONED
order with no entitlement and a CONSUMED entitlement with no account — plus the owner read-model exception
queues for blocked/failed provisioning. One framework; no second engine.

## Whop readiness

See `WHOP_INTEGRATION_READINESS_MATRIX.md`. Items remaining specifically for the Whop phase: signature scheme
confirmation + production secret; Whop payload → normalized field mapping; checkout-model decision (and, if
provider-initiated, an external→internal product resolver); customer→identity resolution; refund/cancel/dispute
event mapping; optional outbox routing for proactive notifications; optional owner UI correlation column.

## §43 — The 36 hard questions (YES/NO + evidence)

1. **One authoritative internal path from verified purchase to account?** YES — `fulfillCompletedOrder` →
   `grantEntitlement` → `provisionFromEntitlement` → `provisionAccount`.
2. **Can the same provider event create two orders?** NO — `commerce_events` unique `(provider, providerEventId)`
   + `commercial_orders` unique `(org, idempotencyKey)`.
3. **Can the same order create two entitlements?** NO — `entitlements` unique `(commercialOrderId, kind)`.
4. **Can the same entitlement create two accounts?** NO — `FOR UPDATE` on the entitlement + `provisioning_requests`
   key + the per-key advisory lock.
5. **Can concurrent delivery create duplicate accounts?** NO — proven by `commerce-chaos`, `multi-instance`, and
   the new `provisioning-idempotency` test (8 racers → 1).
6. **Can an identity reach six active accounts via commerce concurrency?** NO — advisory-lock cap guard; proven
   by `account-limit` + `multi-instance`.
7. **Can a frontend success page provision an account?** NO — only a signature-verified server event does;
   proven.
8. **Is provisioning bound to permanent identity rather than email alone?** YES — bound to `users.id`, which is
   1:1 and permanent with `customer_identities`.
9. **Is product mapping deterministic?** YES — internal `productKey` → newest pinned version at checkout
   (`resolveProfileByKey`).
10. **Can display name alone determine account type?** NO — the pinned `productVersionId` is authoritative.
11. **Can price alone determine account type?** NO — same; price is informational and now validated against the
    order.
12. **Does every commerce-created account retain product/version provenance?** YES — FK to
    `account_profile_versions`.
13. **Does every commerce-created account retain purchase/order provenance?** YES — via
    `entitlements.commercialOrderId` + `consumedByAccountId`.
14. **Can a valid purchase survive a transient provisioning failure without being lost?** YES — money recorded
    first; parks `PROVISION_BLOCKED/FAILED`; recoverable.
15. **Can retry after a process interruption create a duplicate account?** NO — idempotency keys + advisory lock;
    proven by `crash-recovery`.
16. **Can a reset replay create multiple replacement accounts?** NO — order key + entitlement unique + RES-4
    partial unique index; proven by `resilience-races`/`multi-instance`.
17. **Does reset preserve the failed account?** YES — the failed account is never mutated; the successor links
    back via `resetOfAccountId`.
18. **Can Nathan find a provisioning failure without querying the database?** YES — owner provisioning exception
    queue + Customer 360 (`owner-customer.ts`, `CustomersPage.tsx`).
19. **Can Nathan safely retry an ordinary transient provisioning failure?** YES — audited
    `POST /customers/orders/:id/retry-provisioning` → `fulfillPurchaseGated`.
20. **Are operator recovery actions audited?** YES — `commerce.provisioned` / `commerce.provisioning_*` audit
    rows.
21. **Can the customer see truthful pending/failed provisioning state?** YES — `GET /commerce/orders/:id/status`
    and Portal Billing.
22. **Can Portal Billing navigate from order to resulting account?** YES — `GET /portal/orders` carries
    `accountId`.
23. **Can the system detect an order with no entitlement?** YES — new `ORDER_PROVISIONED_NO_ENTITLEMENT`.
24. **Can the system detect an entitlement with no account?** YES — new `ENTITLEMENT_CONSUMED_NO_ACCOUNT`.
25. **Can the system detect multiple accounts from one entitlement?** YES (structurally prevented;
    `DUPLICATE_RESET_SUCCESSOR` / `DUPLICATE_FUNDED_SUCCESSOR` detect the successor analogues).
26. **Can the system detect an ownership mismatch?** Enforced at write (`ORGANIZATION_MISMATCH`); a standing
    detector is not added this phase (documented). Partial — no live risk.
27. **Is money represented without floating-point comparisons?** YES — integer micros; no float compare in the
    commerce path.
28. **Are browser claims prevented from creating verified purchases?** YES — server-event-only; mock gated to
    non-prod.
29. **Does the provider-neutral contract avoid guessed Whop-specific fields?** YES — `NormalizedCommerceEvent`
    is provider-neutral; no Whop JSON added this phase.
30. **Is the architecture ready for a thin Whop adapter next phase?** YES — adapter → normalized event →
    `commerce_events` → unchanged domain.
31. **Did we avoid changing Happy Trader business rules?** YES.
32. **Did we avoid integrating Whop prematurely?** YES — no Whop API/SDK/credential/checkout added.
33. **Did `customer:certify` FAST pass?** YES (run below).
34. **Did `validate:release` pass?** YES (run below).
35. **Is PCV-6 still resolved?** YES — background-worker gating, per-worker isolation, harness and the two flake
    fixes untouched.
36. **Are there zero new P0/P1 defects?** YES.

## Validation

- Server typecheck PASS; focused tests PASS (`provisioning-idempotency` 2, `commerce-fulfillment` incl. 3 new
  GAP-B cases, `commerce-integrity` 2, plus `commerce`, `account-limit`, `state-machine`, `resilience-races`
  regression green).
- `customer:certify` FAST: PASS (recorded in chat).
- `validate:release`: PASS (recorded in chat).
- PCV-6 determinism infra untouched; no concurrency-infra change requiring `test:determinism` beyond the
  advisory-lock addition, which is proven by the concurrency tests above.

## Status

Commerce architecture mapped; provider-neutral boundary safe; idempotency durable; concurrency proven; cap
transactionally safe; purchase → entitlement → account provenance complete both directions; reset replay safe;
failures survive and are recoverable; reconciliation detects broken chains; operator can act without SQL; Portal
Billing truthful; readiness matrix complete; focused tests + certify + validate:release pass; no new P0/P1.

**STOP. Whop is NOT begun.** Human acceptance: PENDING. Next phase: **Whop Commerce Integration.**
