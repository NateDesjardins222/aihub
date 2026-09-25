# Payout Operations — Owner Guide (Milestone 8)

This is the operator's guide to the **Payout Operations** console at
`/admin/payout-operations`. It explains what each queue means, what you can do,
and — importantly — what these controls do *not* do to a trader.

The console is operational. Nothing here changes who is eligible for a payout or
how much they are owed; that is the economics engine, and it is authoritative.

---

## Roles

| Action | SUPPORT | ADMIN | SUPER_ADMIN |
|---|---|---|---|
| Read overview, queues, operation detail, config | ✓ | ✓ | ✓ |
| Edit config / ceilings, open/close the circuit breaker | | ✓ | ✓ |
| Retry a submission, reconcile now | | ✓ | ✓ |
| **Break-glass manual PAID** | | | ✓ |

Every mutating action is audited. RBAC is enforced server-side — hiding a button is
not authorization, and the HTTP tests prove SUPPORT gets `403` on writes and a
trader gets `403`/`404` everywhere they shouldn't reach.

---

## Overview tab

- **Today** — requested / submitted / paid counts and dollar amounts.
- **Speed (request → provider submitted)** — median, P90, **P95 (target < 5m)**,
  P99, and the count over five minutes. This is the SLA that matters:
  request → **provider submission**, not bank settlement.
- **SLA breach line** — if any clean fast-lane payout crossed five minutes, it is
  called out here (and emitted as `payout.sla_breach`). A breach is an *operational*
  alert to investigate the pipeline — never an accusation against the customer, and
  it never delays the payout further or changes eligibility.
- **Health** — exceptions, failed, returned, reconciliation mismatches, provider
  state, circuit-breaker state.

## Queues

- **Fast Lane** — payouts moving through STP (`PAYABLE`/`SUBMITTING`/`SUBMITTED`/
  `PROCESSING`). Healthy operation is a busy fast lane and an empty exceptions tab.
- **Exceptions** — parked payouts, each with a specific category (identity,
  destination, enforcement, treasury, provider unavailable/rejected, duplicate,
  amount, account-state, returned, unknown-provider-state). **A parked payout is
  owed and delayed, not denied.**
- **Processing** — submitted/processing, awaiting provider settlement.
- **Failed / Returned** — terminal operational states needing attention.
- **Reconciliation** — settled/processing payouts and any mismatches.
- **Provider Health** — the configured provider, whether it is configured, its
  state, whether it's the mock (dev/test) or a real provider, and whether
  production is enabled. If nothing is configured, it says so and explains that
  production fails closed.
- **Treasury Controls** — production/provider/breaker/ceilings, and the breaker
  open/close action (ADMIN). See `payout-treasury-controls.md`.

## Operation detail

Open any row to see the full, evidence-based record:

- **Timeline** — customer-safe milestones (Requested → Eligibility confirmed →
  Approved → Submitted → Processing → Paid).
- **Speed** — request→approval, request→submission, submit→ack, submit→paid.
- **Operational checks** — every automated check with its PASS/FAIL/SKIP result.
- **Submission attempts** — each durable attempt, its normalized result, error
  category, retryability, and provider payout id (all on the one stable
  idempotency key).
- **Provider events** — normalized webhook events received.
- **Reconciliation** — any mismatches and how they resolved.

### Actions on a payout (ADMIN)

- **Retry submission** — re-runs `submitPayable`. Safe: the row lock + stable key
  guarantee no duplicate external payout. Use it to nudge a payout a transient
  failure or a cleared treasury/provider block left `PAYABLE`.
- **Reconcile now** — asks the provider for the authoritative state and repairs
  drift (adopts a provider `PAID`, records an amount mismatch or a return).

### Break-glass manual PAID (SUPER_ADMIN only)

This is the *only* way to mark a payout paid by hand, and it is deliberately
heavy:

- SUPER_ADMIN only.
- Requires an **external payment reference** and a **reason (≥10 chars)** — the UI
  disables the button until both are present.
- Fully **audited** (`payout_ops.manual_resolution`) before it applies.
- Records the provider payout id as `MANUAL:<reference>` and settles through the
  same `applyProviderPaid` → `markPaid` path (certificate exactly once).

Use it only when you have out-of-band proof the money moved (e.g. a confirmed wire)
but the provider evidence never arrived. It is never a casual "Mark Paid" button —
the tests assert ADMIN and traders are refused, and that missing evidence is
rejected.

---

## Runbook: common situations

- **Provider outage.** Provider Health shows `DOWN`; payouts park `PAYABLE` /
  `PROVIDER_UNAVAILABLE`. Do nothing — the worker resumes them automatically when
  health returns. Optionally open the breaker if you want to hold submissions
  deliberately.
- **A payout stuck in Processing.** Open it, check provider events; use **Reconcile
  now** to pull the authoritative state. If the provider shows PAID, reconciliation
  settles it.
- **Amount mismatch.** Appears in Reconciliation with `AMOUNT_MISMATCH` and raises
  an M7 signal. Investigate before any manual action; never overwrite the ledger.
- **SLA breach spike.** Check Provider Health and Treasury (is the breaker open? a
  ceiling too low? the provider slow?). The breach is a pipeline signal, not a
  customer problem.
- **Pausing payouts during an incident.** Open the circuit breaker with a clear
  reason (audited). Approved payouts remain owed as `PAYABLE`; close the breaker to
  drain them.

---

## The one thing to remember

Everything in this console is about **operational delivery**. It can pause, retry,
reconcile and (with high authority and evidence) manually settle. It cannot make a
trader ineligible, change what they are owed, reverse a debit, or rewrite paid
history. Eligibility is decided elsewhere and stays authoritative.
