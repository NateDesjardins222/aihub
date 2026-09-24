# Happy Trader Funding — Payout Engine V1

The production-grade eligibility, state, accounting and audit architecture that
will eventually govern real funded payouts. **No real money moves in V1.** No
payout provider, no bank, no KYC vendor. This document is the contract the
implementation honours; `economics-simulator-v1.md` is its separate, synthetic
counterpart.

## 0. Design stance — reuse, don't fork

The prop-firm already has authoritative systems. The payout engine is a new
*consumer* of them, never a parallel source of truth.

| Need | Reused authority (file) |
| --- | --- |
| Immutable product terms (split, caps, buffer, consistency) | `account_profile_versions.config.payoutRules` — pinned per account, published N+1, never mutated (`platform/profiles.ts`) |
| Which account may be paid | a FUNDED_SIM account (`accounts`, `accountType='FUNDED_SIM'`, `sourceQualificationId` set) produced by `approveFunding` (`platform/commerce.ts`) |
| Realized profit / balance | `accounts.balanceMicros`, `startingBalanceMicros`, `realizedPnlMicros`, `feesMicros` — server-authoritative, engine-owned |
| Winning days / best day / consistency inputs | `daily_account_stats` (per trade date) + `accounts.winningDaysCount`/`bestDayProfitMicros`; consistency math from `@atlas/core` |
| Account status / holds | `accounts.status`, `accounts.adminHold` |
| Money-safe mutation | `db.transaction` + `accountAdvisoryLockSql(accountId)` + `SELECT … FOR UPDATE` + `version` CAS (the `account-service.ts` `transition()` template; `approveFunding` idempotency pattern) |
| Audit trail | `recordAudit(scoped, …)` — hash-chained, org-locked (`platform/audit.ts`) |
| Domain events / outbox seam | `events.publish(scoped, …)` + `enqueueOutbox` (`platform/events.ts`) — the schema explicitly reserves the payout seam here |
| RBAC | `requireRole('SUPPORT'|'ADMIN'|'SUPER_ADMIN')` (`http/auth-plugin.ts`); tenancy via `organizationOf(userId)`, every query org-filtered |
| Admin UI | `apps/web/src/admin/*` shell, `FundingPage` pattern, `shared.tsx` primitives, `Admin.css` `adm-*` |

Money is integer **micro-dollars** (`micros()` bigint column helper) everywhere.
Never recompute P&L; read it from the engine's authoritative columns.

The economics simulator lives in a **separate namespace** and can never write to
or read eligibility from production trader/account state.

## 1. Product configuration — `config.payoutRules`

`payoutRules` is today `z.unknown()` on the version config. V1 gives it a typed
schema, pinned immutably per version like every other term. Activation fee lives
here too (there is no dedicated column, and it is a commercial term).

```ts
// PayoutPolicy — stored in account_profile_versions.config.payoutRules
{
  model: 'CORE' | 'SELECT' | 'DAILY',          // which cycle machine governs payouts
  profitSplitPercent: number,                   // 0.90 = 90% to trader
  activationFeeMicros: number,                  // 0 for all current products
  winningDayThresholdMicros: number,            // 150_000_000 ($150)
  requiredWinningDays: number,                  // 5
  // consistency for PAYOUT eligibility (distinct from evaluation consistency,
  // which lives in rules.consistencyThreshold). null = no payout consistency gate.
  payoutConsistencyThreshold: number | null,    // SELECT 0.40; CORE/DAILY null
  // DAILY only: profit that must stay in the account, never withdrawable.
  fundedBufferMicros: number,                   // 0 for CORE/SELECT
  requestCaps: {
    minRequestMicros: number,                   // 250_000_000 / 500_000_000
    // progressive maxima by payout ordinal; last entry is the "established" cap.
    // [payout#1, payout#2, payout#3, …, established]
    maxRequestMicrosByOrdinal: number[],        // e.g. [1_000_000_000] → same each time
  },
}
```

Locked product values (V1), expressed as this policy:

| Product | size | split | winDays | payoutConsistency | buffer | minReq | initial maxReq |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core 25K | 25K | 0.90 | 5 | — | 0 | $250 | $1,000 |
| Core 50K | 50K | 0.90 | 5 | — | 0 | $250 | $2,000 |
| Core 100K | 100K | 0.90 | 5 | — | 0 | $500 | $3,000 |
| Core 300K Gold | 300K | 0.90 | 5 | — | 0 | $500 | $5,000 |
| Select 25K | 25K | 0.90 | 5 | 0.40 | 0 | $250 | $2,000* |
| Select 50K | 50K | 0.90 | 5 | 0.40 | 0 | $250 | $2,000* |
| Select 100K | 100K | 0.90 | 5 | 0.40 | 0 | $500 | $3,000* |
| Daily 25K | 25K | 0.90 | 5 | — | $1,000 | $250 | $1,000* |
| Daily 50K | 50K | 0.90 | 5 | — | $2,000 | $250 | $2,000* |
| Daily 100K | 100K | 0.90 | 5 | — | $4,000 | $500 | $3,000* |

\* Select/Daily payout caps are **configurable, not commercially locked** — the
starred maxima are working defaults pending simulation data (the brief locked
only Core's caps explicitly; the rest reuse the same size-tier values as working
V1 numbers and are overridable per version).

The caps array makes progressive caps first-class: `[1_000_000_000]` means every
payout caps at $1,000; `[1_000_000_000, 1_500_000_000, 2_000_000_000, 3_000_000_000]`
would grow the ceiling with each successful payout, the last entry applying to
every payout thereafter. **Nothing is hard-coded in logic** — the machine reads
the pinned version's policy.

## 2. Eligibility — server-authoritative, never from the browser

Eligibility is computed by `evaluatePayoutEligibility(account, policy, stats,
cycle)` returning a `PayoutEligibility { state, reasonCodes[], withdrawable,
winningDays, bestDay, consistency, … }`. It is a **pure function** of
authoritative inputs, unit-tested exhaustively, and re-verified inside the
approval transaction under lock (never trusted from a prior read).

### 2.1 Winning day (all models)

> Net realized trading P&L after commissions and fees ≥ `winningDayThreshold`
> for the authoritative trading day.

Source of truth: `daily_account_stats` row for `(accountId, tradeDate)`. Day net
= `endingBalanceMicros − startingBalanceMicros` (the account balance is already
net of fees, so this delta *is* net-of-fees realized P&L for the day). A day is
qualifying when that delta ≥ `winningDayThresholdMicros`. Winning days for a
**cycle** are the qualifying days whose `tradeDate` falls after the cycle's start
boundary (funded start, or the finalization date of the last approved payout).
The account's cumulative `winningDaysCount` is *not* used for per-cycle gating —
it counts the account's whole life; cycles reset.

### 2.2 Consistency

`bestDayMicros / totalNetProfitMicros ≤ threshold`. `bestDay` = max day delta in
`daily_account_stats`; `totalNetProfit` = `balanceMicros − startingBalanceMicros`.
Exceeding the threshold **never fails** an account — it only blocks payout
(`CONSISTENCY_NOT_MET`) until further profit lowers the ratio. Evaluation
consistency (qualifying to become funded) already lives in
`rules.consistencyThreshold`; **payout** consistency is a separate gate and only
Select uses it (`payoutConsistencyThreshold = 0.40`).

### 2.3 Withdrawable profit

```
totalNetProfit   = balanceMicros − startingBalanceMicros            (may be ≤ 0)
protected        = fundedBufferMicros            (DAILY only; else 0)
                 + otherReservedMicros           (future holds; 0 in V1)
grossWithdrawable = max(0, totalNetProfit − protected)
```

The **buffer is never withdrawable**. After an approved Daily payout the balance
drops by the paid gross, so `grossWithdrawable` shrinks accordingly while the
buffer stays put (worked example in §5).

### 2.4 Cycle machines

- **CORE** — after funded qualification, need `requiredWinningDays` qualifying
  days. Then eligible subject to withdrawable/min/max/holds. After an approved
  payout, a **new** Core cycle starts (winning-day count resets to the days
  after the payout). Not being currently eligible never fails the account.
- **SELECT** — same as Core **plus** `payoutConsistency ≤ 0.40`. If consistency
  > threshold → `CONSISTENCY_NOT_MET` (blocked, not failed). Trader keeps
  trading until compliant.
- **DAILY** — first complete an **initial** qualification: `requiredWinningDays`
  qualifying days **and** balance has reached `startingBalance + fundedBuffer`
  (buffer established). Once both hold, **Daily payout mode unlocks** and stays
  unlocked: subsequent payouts do **not** require another 5 winning days —
  eligibility is purely `grossWithdrawable ≥ min` and within caps, buffer always
  protected.

### 2.5 Reason codes (enum — never vague strings)

`ELIGIBLE`, `INSUFFICIENT_WINNING_DAYS`, `CONSISTENCY_NOT_MET`, `BUFFER_NOT_MET`,
`BELOW_MINIMUM`, `ABOVE_MAXIMUM`, `INSUFFICIENT_WITHDRAWABLE_PROFIT`,
`ACCOUNT_FAILED`, `ACCOUNT_LOCKED`, `RISK_HOLD`, `FRAUD_HOLD`, `MANUAL_REVIEW`,
`ALREADY_PENDING`. Multiple may apply; the eligibility result carries the full
set so the trader sees every reason, and the UI shows the most actionable first.

`ACCOUNT_FAILED`/`ACCOUNT_LOCKED` derive from `accounts.status`/`adminHold`.
`RISK_HOLD`/`FRAUD_HOLD`/`MANUAL_REVIEW` derive from an operator-set hold on the
payout aggregate (or account). `ALREADY_PENDING` when a non-terminal request
already exists for the account.

## 3. State machine

```
                 request
  NOT_ELIGIBLE ──► (blocked: stays NOT_ELIGIBLE with reasonCodes)
       │
       ▼ (eligibility met)
   ELIGIBLE ──request──► REQUESTED ──review──► UNDER_REVIEW
                              │                    │
                              │                    ├─approve─► APPROVED ─process─► PROCESSING ─paid─► PAID
                              │                    ├─reject──► REJECTED (terminal)
                              │                    └─hold────► UNDER_REVIEW (RISK/FRAUD/MANUAL)
                              └─cancel──► CANCELLED (terminal, trader/operator, pre-approval)
   APPROVED/PROCESSING ─fail─► FAILED (terminal; provider failure — future)
```

- `ELIGIBLE` and `NOT_ELIGIBLE` describe the **account's** current standing (a
  computed view), not a stored request. A stored `payout_requests` row starts at
  `REQUESTED`.
- Transitions are validated by an explicit allowed-transition table; an illegal
  transition throws `INVALID_TRANSITION` and moves no money.
- **Balance is adjusted exactly once**, at the `APPROVED` transition (the moment
  the firm commits the liability), recorded in the ledger. `PROCESSING`→`PAID`
  moves no balance (it reflects external settlement, mocked in V1).
- `REJECTED`/`CANCELLED`/`FAILED` never adjust balance. If a `FAILED` follows an
  `APPROVED` that already debited, a compensating ledger reversal restores the
  balance (append-only — the debit and its reversal both stay in the ledger).

## 4. 90% split — explicit accounting

Every payout records, separately and reconcilably:

```
grossEligibleMicros   = min(requestedGross, grossWithdrawable, capForOrdinal)
traderShareMicros     = round_half_even(grossEligible × profitSplitPercent)
firmShareMicros       = grossEligible − traderShareMicros      // exact, no rounding gap
balanceAdjustmentMicros = grossEligible                        // full gross leaves the account
actualPayoutMicros    = traderShareMicros                      // what the trader receives
feesMicros            = 0                                       // no payout fees in V1
```

Invariant, asserted in tests: `traderShare + firmShare == grossEligible` exactly
(integer micros, so the firm share absorbs the rounding remainder — the split is
never ambiguous). The **account balance decreases by the full gross**, because
the firm's share is the firm's revenue, not a balance the trader keeps. The
trader receives `traderShare`. All six numbers persist on the ledger row.

Rounding: banker's rounding on `traderShare`, `firmShare` as the exact
complement, so the two always reconcile to `grossEligible` with zero drift.

## 5. Daily buffer — worked example

50K Daily, `fundedBuffer = $2,000`, balance `$53,500`:

```
totalNetProfit    = 53,500 − 50,000 = 3,500
protected buffer  = 2,000
grossWithdrawable = 3,500 − 2,000 = 1,500
```

Trader requests $1,000 (≥ $250 min, ≤ cap), approved:

```
grossEligible      = 1,000
traderShare        = 900   (90%)
firmShare          = 100
balanceAdjustment  = 1,000
balance after      = 53,500 − 1,000 = 52,500
remaining grossWithdrawable = 52,500 − 50,000 − 2,000 = 500
```

The buffer ($2,000) stays protected throughout. A request that would push
`balance − starting` below `starting + buffer` is rejected
`INSUFFICIENT_WITHDRAWABLE_PROFIT` before any money moves.

## 6. Idempotency & concurrency — treat it like the execution engine

- **Request**: `payout_requests` carries a client-supplied `idempotencyKey`,
  unique per `(organizationId, idempotencyKey)`. A duplicate request (double
  click, browser refresh, retry) returns the existing row, never a second
  liability. A second *non-terminal* request for the same account is refused
  `ALREADY_PENDING`.
- **Approval**: performed in `db.transaction` under `accountAdvisoryLockSql` +
  `SELECT … FOR UPDATE` on both the request and the account, guarded by the
  request `version` (CAS). Two operators approving simultaneously: the first
  commits `APPROVED` + the single balance debit + ledger row; the second sees
  `version` moved / state no longer `REQUESTED|UNDER_REVIEW` and is a no-op
  (`INVALID_TRANSITION` or idempotent success returning the same result).
- **Balance debit exactly once**: enforced by (a) the state guard (only a
  `REQUESTED|UNDER_REVIEW`→`APPROVED` transition debits) and (b) a unique
  `payout_ledger` index on `(payoutRequestId, entryType='DEBIT')`. A duplicate
  approval cannot insert a second debit row.
- **Future provider webhook** `PROCESSING`→`PAID`: idempotent on a
  `(payoutRequestId, entryType='SETTLEMENT')` unique key; a duplicate webhook is
  a no-op.

Concurrency is tested: duplicate request, duplicate approval, two simultaneous
approvals, refresh-resubmit — each asserts exactly one liability and one debit.

## 7. Ledger — append-only, reconstructable

`payout_ledger` is append-only (never updated/deleted). Each row is one money
event for a request: `entryType ∈ {DEBIT, REVERSAL, SETTLEMENT}`, `amountMicros`,
`balanceBeforeMicros`, `balanceAfterMicros`, plus the full accounting snapshot
(`grossEligibleMicros`, `traderShareMicros`, `firmShareMicros`, `protectedBufferMicros`,
`withdrawableBeforeMicros`, the pinned `productVersionId`, and the
`eligibilitySnapshot` jsonb). Given a request id we can reconstruct: balance
before → realized profit → withdrawable → protected buffer → requested gross →
trader amount → firm share → balance adjustment → balance after. **Trades are
never modified to make a payout**; the ledger is the payout's own truth.

## 8. Audit — deterministic evidence

Every transition writes a hash-chained audit row via `recordAudit(scoped, …)`
inside the same transaction, `subjectType='PAYOUT'` (union extended),
`subjectId = payoutRequestId`, `accountId` set, dotted action:
`payout.eligibility_unlocked`, `payout.requested`, `payout.blocked`,
`payout.under_review`, `payout.approved`, `payout.rejected`, `payout.cancelled`,
`payout.processing`, `payout.paid`, `payout.failed`, `payout.hold_placed`,
`payout.hold_removed`, `payout.balance_adjusted`. `prevState`/`newState` capture
the transition; `reason` required for sensitive manual actions; `context` carries
the rule snapshot id and eligibility result. This answers "why was this trader
allowed to withdraw $X on this date?" with a tamper-evident chain. A matching
domain event (`payout.*`) is published to the outbox for downstream fan-out.

## 9. Owner control center (`/admin/payouts`)

Real backend state, never a mock. Queues by state (Pending/Under Review/Approved/
Processing/Paid/Rejected/Failed). Each row: trader, account (public id), product,
size, request amount, trader share, firm share, current balance, protected buffer,
withdrawable, winning days, best day, consistency %, account status, holds,
request time. A row opens the full **payout case**: eligibility calculation, the
pinned rule snapshot, the balance calculation, trading statistics, relevant
account events, audit history, operator notes. Actions: Approve, Reject, Place
Hold, Remove Hold, Cancel (where valid) — reason required for sensitive actions,
RBAC enforced server-side (`requireRole('ADMIN')` to act, `'SUPER_ADMIN'` for
config/caps; `'SUPPORT'` read floor).

## 10. Firm payout exposure

An owner exposure view distinguishing three things it never conflates:

- **realized historical payouts**: sum of `PAID` (ledger settlements) — today, 7d,
  30d, all-time.
- **currently requested liability**: gross of all non-terminal requests
  (`REQUESTED`/`UNDER_REVIEW`/`APPROVED`/`PROCESSING`).
- **currently eligible/withdrawable exposure**: sum of `grossWithdrawable` across
  all funded accounts *if every eligible trader requested their maximum* — a
  ceiling, not a liability.

Broken down by model (Core/Select/Daily) and account size. Plus a ratio
`payout liability / gross revenue` with each of the three numerators shown
separately and labelled, never merged.

## 11. Product versioning — immutable contracts

A trader bought version N. Publishing N+1 with new payout rules leaves the
existing account governed by its pinned version's `payoutRules`. The engine reads
`resolveProfileVersion(db, account.fundedProfileVersionId ?? account.profileVersionId)`
and never the latest. A migration to N+1 is an explicit, audited operator action,
never silent. This reuses the existing immutable-version guarantee unchanged.

## 12. Schema (migration `0017_payouts.sql`)

```
payout_requests
  id uuid pk
  organization_id uuid   → organizations
  account_id uuid        → accounts
  user_id uuid           → users
  product_version_id uuid→ account_profile_versions   (pinned at request)
  cycle_id uuid          → payout_cycles              (which qualification cycle)
  state varchar(20)      DEFAULT 'REQUESTED'
  requested_gross_micros bigint
  gross_eligible_micros  bigint                        (set at approval)
  trader_share_micros    bigint
  firm_share_micros      bigint
  fees_micros            bigint DEFAULT 0
  balance_adjustment_micros bigint
  protected_buffer_micros bigint
  withdrawable_before_micros bigint
  eligibility_snapshot   jsonb                         (reason codes, winDays, bestDay, consistency)
  payout_ordinal integer                               (1-based; drives progressive cap)
  hold_kind varchar(16)                                (RISK|FRAUD|MANUAL, null when none)
  reason text
  idempotency_key varchar(200)
  version integer DEFAULT 0                            (CAS)
  requested_by_user_id uuid
  decided_by_user_id uuid
  created_at / updated_at / decided_at / paid_at timestamptz
  UNIQUE (organization_id, idempotency_key)
  INDEX (organization_id, state), (account_id)

payout_ledger        (append-only; UPDATE/DELETE rejected by trigger)
  id uuid pk
  organization_id uuid
  payout_request_id uuid → payout_requests
  account_id uuid
  entry_type varchar(16)  (DEBIT|REVERSAL|SETTLEMENT)
  amount_micros bigint
  balance_before_micros bigint
  balance_after_micros bigint
  gross_eligible_micros / trader_share_micros / firm_share_micros / protected_buffer_micros bigint
  product_version_id uuid
  meta jsonb
  created_at timestamptz
  UNIQUE (payout_request_id, entry_type)               (debit/settlement once)

payout_cycles        (a Core/Select/Daily qualification cycle per account)
  id uuid pk
  organization_id uuid
  account_id uuid
  model varchar(8)   (CORE|SELECT|DAILY)
  ordinal integer                                      (1-based cycle number)
  started_on date                                      (cycle winning-day window start)
  daily_mode_unlocked boolean DEFAULT false            (DAILY: buffer+winDays established)
  closed_at timestamptz                                (set when a payout closes the cycle)
  created_at timestamptz
  UNIQUE (account_id, ordinal)
```

Balance mutation happens on `accounts.balanceMicros` under the existing account
advisory lock, in the same transaction as the ledger DEBIT, so the balance and
the ledger can never disagree.

## 13. What V1 does NOT do

No real payout provider, bank, KYC vendor, Whop, or Databento wiring. `PROCESSING`
and `PAID` are operator/mock transitions; no external settlement occurs. This is
the financial brain, built and proven before real money is connected to it.

## 14. Open questions / remaining unknowns

- Final commercial payout caps for Select/Daily (working defaults pending
  simulation).
- Whether progressive caps ship on at launch or stay flat (architecture supports
  both; default flat).
- Reserve multiplier policy (illustrative only in V1 — see the simulator doc).
- Tax/1099 handling — explicitly out of scope for V1.
