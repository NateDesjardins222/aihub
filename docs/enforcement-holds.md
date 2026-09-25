# Enforcement Holds (M7)

Holds are the durable, **server-authoritative** mechanism that gates a capability
while a case is open or a decision stands. There is no hidden boolean scattered
through the code — a single hold table plus one central evaluator
(`activeHolds` / `holdFor`) is consulted at every integration seam.

## Model (`enforcement_holds`)

- `id`, `organizationId`, `caseId` (nullable — a containment hold can precede a case)
- `scope`: `CUSTOMER | ACCOUNT | PAYOUT | COMMERCE`
- `scopeId`: the customerIdentityId / accountId / payoutRequestId / (commerce = customerIdentityId)
- `capability`: `TRADING | PAYOUT_REQUEST | PAYOUT_APPROVAL | PURCHASE | ACCESS`
- `reasonCode`, `customerSafeCategory`
- `status`: `ACTIVE | RELEASED | EXPIRED`
- `createdAt`, `createdBy`, `expiresAt?` (nullable), `releasedAt?`, `releasedBy?`, `releaseReason?`
- `version` (optimistic), `idempotencyKey` (unique) so a retried placement never double-inserts

A hold is **effective** when `status='ACTIVE'` and (`expiresAt` is null or in the
future). `activeHolds(db, {customerIdentityId, accountId})` returns the effective
set for a subject; capability checks call the narrow helper `holdBlocks(...)`.

## Capability evaluation at each seam

| Seam | Holds checked | Effect |
|---|---|---|
| Order submission (engine) | ACCOUNT/`TRADING` for the account + CUSTOMER/`TRADING` for its owner | Reject **exposure-increasing** orders only (see below) |
| Payout request | ACCOUNT/`PAYOUT_REQUEST`, PAYOUT/`PAYOUT_REQUEST`, CUSTOMER/`PAYOUT_REQUEST` | Block new request; surfaced as `ENFORCEMENT_HOLD` |
| Payout approval | same + `PAYOUT_APPROVAL` scope/capability | Block approval/debit |
| Commerce checkout | CUSTOMER/`PURCHASE` | Block pre-checkout |
| Auth (optional) | CUSTOMER/`ACCESS` | Only where the security architecture supports it safely |

## Trading-hold safety (CRITICAL — must never strand a position)

A `TRADING` hold reuses the exact reduce-only-safe rule the personal risk gate uses:
it evaluates only the **exposure-increasing** portion of an order
(`increasingQty(positionQty, signedQty) > 0`). It therefore:

- **Blocks:** new positions, increasing exposure, reversals that create new opposite exposure.
- **Always permits:** reducing exposure, flattening, protective stops, protective
  targets, cancelling orders, reducing bracket quantity, and any liquidation the
  engine itself issues.

The check runs after the firm gate and personal risk gate, in the same account
mutex, and never overrides a firm allow/reject.

## Payout holds and PAID history

A payout hold distinguishes: request blocked / approval blocked / already-approved /
already-paid. A hold **never** rewrites a `PAID` payout ledger entry. If a case
opens after payment, it is recorded for investigation/recovery/legal operations;
historical payout accounting is never corrupted. A pending payout is held visibly
with a customer-safe status ("temporarily under review"), never labelled "fraud"
unless a confirmed finding and policy support that wording.

## Automatic containment (high-confidence only)

Allowed automatic actions: revoke sessions / step-up on credible session
compromise; block a duplicate payout movement on idempotency conflict; reject an
impossible authenticated ownership request; security containment on confirmed
tampering; commerce/payout review on a provider-reported reversal.

**Never** automatic: termination for a VPN, IP change, new device, travel, a
chargeback alone, trade similarity, high profits, short hold time, news trading, a
large payout request, or multiple accounts within the permitted limit.

## Release & expiry

Releasing a hold sets `status='RELEASED'`, `releasedBy`, `releaseReason`, audited.
A `RESOLVED_NO_ACTION` case release removes its temporary holds and restores the
capability. Expiry (`expiresAt` in the past) makes a hold non-effective without a
write; a sweep may mark it `EXPIRED` for tidiness. Release/placement are idempotent.
