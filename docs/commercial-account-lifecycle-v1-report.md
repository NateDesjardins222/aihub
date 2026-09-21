# Commercial Account Lifecycle V1 — closure report

Branch `claude/futures-trading-simulator-v8qefu`. Baseline `16ac242`
(Professional Market Data V2 offline gate). This milestone built the
authoritative, provider-independent prop-firm account lifecycle:

> commercial order → entitlement → evaluation → trade → rule engine →
> pass/fail → funding eligibility → funded-sim account

A future payment provider is only a trigger into this domain. **No real money
moves anywhere in this milestone.**

---

## What this milestone is NOT — read this first

To avoid making Atlas sound more complete than it is:

- **REAL PAYMENTS ARE NOT IMPLEMENTED.** There is no Stripe/Whop integration,
  no checkout, no credit-card handling, no billing. `commercialOrders.amountMicros`
  is an informational field; nothing charges it. The order is recorded as
  `COMPLETED` by a trusted caller (an admin grant today; a verified payment
  webhook later) — the commercial layer never sees a card.
- **REAL PAYOUTS ARE NOT IMPLEMENTED.** No withdrawals, no bank transfers, no
  KYC/AML, no tax forms, no affiliate or promo machinery, no revenue dashboard.
  The `payoutRules` product field is carried through unchanged and unused by
  this milestone. Funding *approval* provisions a simulated account; it never
  pays anyone.
- **REAL BROKERAGE / LIVE FUNDED ACCOUNTS ARE NOT IMPLEMENTED.** A funded
  account is `FUNDED_SIM`: the same simulated execution engine as an evaluation,
  labelled as funded. `FUNDED_LIVE` is not built and is not faked. No order in
  this platform reaches a real market.
- **AUTHENTICATED DATABENTO IS PAUSED.** No authenticated market-data work was
  done or resumed. `DATABENTO_API_KEY` was not requested. No CME subscription
  was purchased or configured. The provider-independent market-data architecture
  is intact and untouched.
- **No fake checkout, fake payments, or fake payouts were built.** The absent
  payment step is genuinely absent, not simulated with a mock card form.

---

## The domain model

Three additive tables (migration `0015_commercial_lifecycle.sql`), plus three
nullable linkage columns on `accounts`. Every existing account carries NULL in
the new columns and behaves exactly as before.

| Concept | Table | Purpose |
| --- | --- | --- |
| Commercial order | `commercial_orders` | A purchase or an admin grant. `source` distinguishes them; `idempotencyKey` dedupes a webhook that fires twice. |
| Entitlement | `entitlements` | The right to one account, granted by an order (or directly by an admin). Consumed exactly once. |
| Qualification | `account_qualifications` | The immutable record that an evaluation passed: the evidence snapshot, the balance, and the funding decision. |
| Funded linkage | `accounts.source_qualification_id` / `source_account_id` / `funded_profile_version_id` | Ties a funded account back to the evaluation and pins its destination product version at acquisition. |

### The lifecycle service — `platform/commerce.ts`

One door for a purchase and an admin grant, differing only in `source`:

- `completeCommercialOrder` — idempotent by `(org, idempotencyKey)`.
- `grantEntitlement` — idempotent by `(commercialOrderId, kind)`.
- `provisionFromEntitlement` — consumes an entitlement into exactly one account,
  pins the funded destination version at acquisition (Phase 50).
- `acquireEvaluation` — the three above in one call.
- `certifyEvaluation` — **server-authoritative pass.** See below.
- `approveFunding` / `declineFunding` — the funding transition.

### Server-authoritative, one-way pass

The engine's `PASSED` is a per-mark verdict that **reverses** if the trader
gives the profit back. That is correct for the engine and wrong for a sale: a
prop firm does not un-pass a trader who hit the target. The commercial layer
adds a one-way certification:

- The engine reaching `PASSED` publishes the durable `account.passed` event
  (unchanged). A new **additive subscriber** (`commerce-certify.ts`) turns that
  into a certification. The reliability spine is untouched — the engine does not
  know the subscriber exists.
- `certifyEvaluation` re-checks the authoritative `statusFromState` (every
  requirement met, a positive profit target), then, under an advisory lock and a
  `FOR UPDATE` re-read (the pass/fail race), **freezes** the account:
  `status = PASSED`, `adminHold = QUALIFIED`. `persistRuleState` only writes the
  effective status when `adminHold is null`, so the reversible engine can no
  longer un-pass it, and the existing order gate rejects new orders with
  `ACCOUNT_PASSED`. Terminal-after-pass, with no engine change.
- The qualification row is unique per `(account, lifecycle)` and carries an
  immutable evidence snapshot.
- A **startup sweep** (`certifyPassedEvaluations`) certifies any evaluation a
  crash left `PASSED` without a qualification, so a pass is never lost.

### The funded transition

- `PASSED` ≠ `FUNDING_ELIGIBLE` ≠ `FUNDED`: a qualification starts `ELIGIBLE`
  and only becomes `FUNDED` on approval (automatic or owner).
- `approveFunding` provisions a **separate** `FUNDED_SIM` account — the
  evaluation is never mutated into the funded account. Both survive; the funded
  account links back via `source_qualification_id` / `source_account_id`, and is
  pinned to the funded product version recorded at acquisition, independent of
  the evaluation's version and of any later change to the funded product.
- A product with no funded destination surfaces `NO_FUNDED_DESTINATION` at
  approval rather than provisioning a wrong account.

### Idempotency and concurrency

Every step is idempotent. During the torture harness, **two real
double-provisioning defects were found and fixed**: two concurrent acquisitions
of one order made two accounts, and two concurrent funding approvals of one
qualification made two funded accounts — the same gap, an unserialized
`provisionAccount` key check. The fix is in the commerce layer, **not** the
reliability spine: `provisionFromEntitlement` and `approveFunding` now run their
whole critical section in a transaction holding a `FOR UPDATE` row lock on the
entitlement / qualification, so a racing caller blocks until the first commits
and then reads the finished result. Both are covered by always-run regression
tests and re-verified by the harness.

---

## The owner console

Added to `/api/v1/admin`, reusing its role (`ADMIN` to act) and tenancy guards:

- `GET /funding-queue?state=` — the passed queue (ELIGIBLE by default), each row
  showing the trader, the evaluation, and whether a funded destination is pinned.
- `GET /qualifications/:id` — the qualification with its immutable evidence and
  the funded account it produced.
- `POST /qualifications/:id/approve-funding` — one funded account, idempotent.
- `POST /qualifications/:id/decline-funding` — with a required reason.
- `POST /grants` — a manual owner grant travelling the identical
  order → entitlement → evaluation path a purchase will (`source = ADMIN_GRANT`).

Web (`apps/web/src/admin`): a **Funding** page (passed queue, state tabs, inline
approve/decline, links to the evaluation and the funded account), and the
account-detail page now shows an account's commercial lifecycle — the
qualification it earned and, on a funded account, the evaluation it came from.
Professional and quiet: no confetti. No redesign of the console or terminal.

---

## The payment / payout seams (Phase 68–69, deliberately NOT implemented)

- **Payment seam.** `completeCommercialOrder` is the exact boundary a verified
  payment webhook will call: it takes `source`, `externalProvider`,
  `externalReference`, `amountMicros`, `currency` and an `idempotencyKey`, and it
  is idempotent. Wiring a provider means authenticating its webhook and calling
  this function; nothing downstream changes. It is **not** wired, and no provider
  SDK is present.
- **Payout seam.** Funding approval ends at a `FUNDED_SIM` account. A payout
  system would attach to the `account.funded` domain event and the `payoutRules`
  product field. Neither is implemented.

---

## Verification

All figures below are from actual runs against real PostgreSQL, not estimates.

| Check | Result |
| --- | --- |
| Full test suite (`pnpm -s test`, isolate mode) | **843/843 passed, 52 files** (baseline 821 + 22 new commerce tests) |
| Server typecheck | clean |
| Web typecheck | clean |
| Commercial lifecycle E2E (`scripts/e2e-commercial-lifecycle.ts`) | **12/12 steps PASS** |
| Commercial lifecycle torture (`scripts/torture-commercial-lifecycle.ts`) | **0 invariant violations**, seeds 1/2/3/7/11, 48–150 concurrent traders |

### Commerce test coverage (22 tests, always run)

Acquisition (idempotent purchase, concurrent-purchase-makes-one-account, admin
grant via the same path, entitlement consumed once), certification (refused
below target, freezes on pass with immutable evidence, idempotent, refuses a
failed account, startup sweep), funding (one funded account, concurrent-approval
-makes-one, decline-then-refuse, no-destination, audit trail), and the owner
console over HTTP (queue, idempotent approve, decline-then-refuse, manual grant,
evidence detail, a trader refused the console).

### E2E scenario (12 ordered steps, against the real engine)

acquire · retry · below-target · auto-certify · duplicate-pass · terminal-after
-pass order rejection · approve funding · retry approval · failure terminal ·
tenant isolation · restart-sweep recovery · final reconciliation.

### Torture invariants (re-checked every batch)

I1 one account per consumed entitlement · I2 one funded account per FUNDED
qualification · I3 no evaluation reused as a funded account · I4 terminal-after
-pass never reverts · I5 one qualification per (account, lifecycle) · I6 funded
accounts link back · I7 integer balances · I8 no cross-org leakage.

---

## Standing constraints honoured

- PostgreSQL is the only source of financial truth; no fabricated `$0`.
- Tenant/organisation isolation preserved and tested (I8, E2E step 10).
- No test strictness reduced; no results faked; nothing marked passing that was
  not run.
- The reliability spine (execution engine, account state, P&L, rule engine,
  events, projections, audit) was not modified. The commercial layer plugs in
  via an additive subscriber and additive tables; the one concurrency fix lives
  in the commerce layer.
- No model identifiers in code, commits, or this report.
