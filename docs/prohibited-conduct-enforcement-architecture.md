# Prohibited Conduct + Enforcement + Appeals — Architecture (M7)

Philosophy: **detect aggressively, accuse conservatively, automate clear safety
actions, require strong evidence for punitive actions, preserve human review and
appeal rights, never punish a trader for being profitable.** A *signal* is not a
*finding*; a *temporary hold* is not a *conviction*; a *rule breach* is not
*misconduct*.

This milestone adds an enforcement/investigation/holds/appeals domain that reuses
the existing platform primitives rather than duplicating them.

## What already exists (reused, not rebuilt)

| Need | Existing primitive | M7 use |
|---|---|---|
| Person spine | `customer_identities` (`status ACTIVE/HOLD/CLOSED`, `setIdentityHold`) | hold subject; person-scoped containment |
| Account operator hold | `accounts.adminHold` + `lockAccount/unlockAccount` | full account lock (blocks *all* orders incl. reduce) |
| Payout hold | `payout_requests.holdKind` (RISK/FRAUD/MANUAL) + `placeHold/removeHold` | per-request review hold |
| Execution gate | `TradingEngine.submitOrder` → `checkOrder` (firm) + `checkPersonalRisk` (personal, `increasingQty`, `liquidation` skip) | **the reduce-only-safe pattern M7 mirrors** |
| Copy fan-out | each follower routes through `execution.submitOrder` | trading holds auto-gate followers |
| Commerce | `checkoutRoutes` + `evaluateProvisioningGate.blockedReasons` | pre-checkout hold |
| Auth | `refreshTokens`, `users.status`, `requireRole` (live DB re-read) | session revoke + user disable |
| Audit | `recordAudit` (hash-chained, append-only) | every enforcement mutation |
| Notifications | `enqueueNotification` + consumer switch | customer-safe review/appeal notices |
| Events | `events.publish` + deferred bystanders | `enforcement.*` / `appeal.*` |
| Agreements | `agreementVersions` incl. **`TRADER_PLEDGE`** type + `outstandingAgreements`/`acceptAgreements` | **policy acceptance — no new table** |
| Reason codes | `RejectReason`, `PayoutReasonCode`, `blockedReasons`, … | extend, don't invent |

## What M7 adds

**Schema (migration 0027, additive):**
`enforcement_cases`, `enforcement_signals`, `enforcement_evidence`,
`enforcement_findings`, `enforcement_actions`, `enforcement_holds`,
`enforcement_notes`, `enforcement_information_requests`, `enforcement_appeals`,
`enforcement_appeal_decisions`. Policy acceptance reuses `agreementVersions` /
`agreementAcceptances` (`TRADER_PLEDGE`) — **no `policy_acceptances` table.**

**Pure module** `enforcement-core.ts` — reason-code taxonomy, severity derivation
(explicit, no black-box score), case-state transition validation, hold-effective
predicate, customer-safe reason mapping. No I/O.

**Service** `enforcement.ts` — signal ingestion (idempotent, correlated), case
open/triage/assign/transition, evidence append, findings, actions, hold
place/release (idempotent, versioned), information requests, appeals + appeal
decisions, remediation via existing ledger-safe primitives, all under advisory
locks + `recordAudit` + `events.publish`.

**Hold reads (`enforcement-holds.ts` helper)** consulted at each seam:
`activeHolds(db, {customerIdentityId, accountId, payoutRequestId})` +
`holdBlocks(...)`.

**Integration seams:**
1. Execution — `TradingEngine.checkEnforcementHold` beside `checkPersonalRisk`,
   reuses `increasingQty` + `liquidation` skip → new `RejectReason`
   `ACCOUNT_ENFORCEMENT_HOLD`; auto-covers copy followers.
2. Payout — enforcement check in `requestPayout` and inside `approvePayout`'s
   under-lock re-verification; surfaced in eligibility as `ENFORCEMENT_HOLD`.
3. Copy leader — optional check in `submitCopyIntent` beside `leaderElig`.
4. Commerce — predicate in checkout before `createPendingOrder` and in
   `evaluateProvisioningGate` (`blockedReasons`) so webhook purchases are blocked too.
5. Auth — `revokeAllSessions(userId)` (bulk-revoke refresh tokens) + optional
   `users.status='DISABLED'`; `requireRole`/`login`/`refresh` already reject non-ACTIVE.
6. Policy — a versioned `TRADER_PLEDGE` prohibited-conduct agreement; acceptance via
   the existing agreement gate.

**HTTP:** owner endpoints under `/api/v1/admin/enforcement/*` (`requireRole`,
four-eyes on serious/terminal actions); trader endpoints under
`/api/v1/portal/enforcement/*` (owner-scoped, IDOR-guarded, customer-safe only).

**Web:** admin **Enforcement** workspace (Review Queue, Cases, Appeals, Holds,
Signals, Summary); portal **Account Review** page (customer-safe status + info
response + appeal).

## Non-negotiables encoded in code + tests

Profitability, VPN, new device, travel, chargeback-alone, trade-similarity-alone,
platform-bug-alone, and rule-breach are **never** violations. A trading hold never
blocks risk-reduction. PAID payout history is never rewritten. Punitive action needs
evidence + authority. Appeals exist for eligible serious adverse decisions. No
black-box fraud score. No invasive surveillance. Server authority always.

See: `enforcement-reason-codes.md`, `enforcement-case-lifecycle.md`,
`enforcement-holds.md`, `enforcement-appeals-v1.md`, `enforcement-owner-operations.md`,
`happy-trader-prohibited-conduct-policy-v1.md`.
