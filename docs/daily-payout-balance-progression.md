# Daily Payout Progressive Qualifying-Balance Rule (Milestone 6)

A new **locked** business rule, decided after Milestone 5, applying **only to DAILY
funded accounts**:

> Each successive Daily payout requires the account to qualify at a **strictly
> higher** account balance than the qualifying balance used for the previous
> approved Daily payout.

It **stacks with** — never replaces — every existing Daily requirement (protected
buffer, initial five winning days ≥ $150, daily-mode unlock, the 50% rule, payout
cap, payout minimum, 90/10 split, active/tradeable lifecycle, holds, and the max
five payout cycles).

## Canonical unit and "strictly higher"

Money is integer **micro-dollars** (`MICROS = 1_000_000`) throughout. "Strictly
higher" is `currentQualifyingBalance > previousQualifyingBalance` in micro-dollars.
The previous threshold exactly is **not** enough; one micro-dollar above it is.
There is no float comparison.

## What "qualifying balance" means and when it is snapshotted

The qualifying balance is the **authoritative account balance at the payout's
approval/debit boundary**, captured *before* the debit — i.e. `balanceBefore` in
`approvePayout` (`apps/server/src/platform/payouts.ts`). Approval is the existing
exactly-once money-movement boundary (the single point the balance is debited under
the account advisory lock + `SELECT … FOR UPDATE` + version CAS), so the snapshot
inherits those protections for free. It is **never** derived later from the mutable
current balance, and never taken from the request timestamp.

It is persisted immutably on the payout request row:

- `payout_requests.qualifying_balance_at_approval` (micro-dollars, nullable;
  populated at APPROVED). Migration **0024**, additive.

`previousPayoutQualifyingBalance` for the *next* eligibility decision is derived
from the most recent already-approved Daily payout's immutable snapshot — not from
any mutable running total.

## Where the rule is enforced

Pure decision in `payout-core.ts`, re-run inside the approval lock (never trusted
from a stale client read):

- `EligibilityInput` gains `previousDailyQualifyingBalanceMicros: number | null`.
- `evaluatePayoutEligibility` adds, for `model === 'DAILY'` only, when a previous
  snapshot exists and `balanceMicros <= previousDailyQualifyingBalanceMicros`:
  reason code **`DAILY_BALANCE_PROGRESSION_NOT_MET`**.
- `MAX_CYCLES_REACHED` is also added: once the account has been paid its maximum
  cycles (5), no further payout qualifies (this is what drives account completion,
  below).

`buildContext` in `payouts.ts` loads the previous approved Daily snapshot and
passes it in, so both the read-only eligibility endpoint and the approval re-check
apply the rule identically. `requestPayout` and `approvePayout` both re-run the
pure decision; the **approval transaction is the final authority**. A frontend
eligibility result is informational only.

## Reason code and UI

`DAILY_BALANCE_PROGRESSION_NOT_MET` is surfaced through `presentEligibility` and the
portal Payout Center, which shows, for Daily accounts:

- Previous qualifying balance: `$X` (or "First payout — no previous
  qualifying-balance threshold.")
- Current qualifying balance: `$Y`
- Required next qualifying balance: `> $X`
- Remaining: `$Z` (= `X − Y + 1 micro`, floored at 0)

The blocked reason renders as a deterministic sentence, never a bare "Not
eligible": *"Your balance must exceed the qualifying balance used for your previous
Daily payout."*

## Account completion (max cycles)

When the **fifth** payout for an account reaches its terminal money state (PAID),
the account transitions to `COMPLETED` and publishes `account.completed` with
`{ totalTraderShareMicros }` (sum of trader-share of that account's PAID payouts).
This is the previously-missing producer for the derived `COMPLETED_MAX_PAYOUTS`
portal state, and it is what triggers the ACCOUNT_COMPLETED certificate
(`docs/rewards-certificates-v1.md`). A completed account is no longer payout-eligible
(`MAX_CYCLES_REACHED`).

## Concurrency & correctness properties (tested)

- First payout: no previous threshold, rule inert.
- Approval stores `qualifying_balance_at_approval = balanceBefore`.
- Second payout at the exact same balance → rejected; lower → rejected; strictly
  higher → accepted.
- The stored threshold is unaffected by the payout debit (it is a snapshot, not a
  live read).
- Retries / concurrent approvals do not change the snapshot (idempotent approval).
- CORE and SELECT accounts are unaffected (rule is DAILY-only).
- All other Daily rules still enforced; the fifth-payout completion still works.
