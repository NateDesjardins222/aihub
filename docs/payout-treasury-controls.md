# Treasury Controls & the Circuit Breaker (Milestone 8)

Treasury controls govern **when Happy Trader submits approved payouts to the
provider** — a purely operational lever. They exist so an owner can pause or
throttle *external submission* during an incident (a provider outage, a treasury
funding delay, a suspected problem) **without ever touching who is eligible or
what they are owed.**

> A treasury delay or an open breaker means *"approved and owed, but operationally
> paused"* — never *"ineligible"*, never *"fraud"*, and never a rewrite of paid
> history. Liabilities and the ledger are untouched.

Source: `apps/server/src/platform/payout-ops-config.ts`
(`getOpsConfig`, `updateOpsConfig`, `openCircuitBreaker`, `closeCircuitBreaker`,
`treasuryGate`), the `payout_operations_config` and
`payout_circuit_breaker_events` tables, the owner routes in `payout-ops.ts`.

---

## Configuration (`payout_operations_config`, one row per org)

| Field | Meaning | Default |
|---|---|---|
| `productionEnabled` | real external money movement is allowed | **false** |
| `provider` | configured provider id (`MOCK` / vendor / null) | null |
| `maxSingleAutoMicros` | ceiling above which a single payout leaves the fast lane for treasury review | none |
| `maxAggregateAutoPerDayMicros` | daily auto-submission ceiling across the org | none |
| `circuitBreakerOpen` | external submission paused | false |
| `reconStaleThresholdSeconds` | age at which SUBMITTED/PROCESSING is reconciled | 900 |
| `version` | optimistic-concurrency version | 0 |

**Production is disabled by default.** Until an owner explicitly configures a
provider *and* enables production, no real money can move; a real provider with
production off, or a mock in production, fails closed (see the provider doc).

`updateOpsConfig` is **audited** (`payout_ops.config_updated`) and supports
optimistic concurrency: a stale `expectedVersion` throws `CONFIG_CONFLICT` (surfaced
as HTTP `409`), so two operators can't silently clobber each other.

---

## The treasury gate

`treasuryGate(db, org, amountMicros, config)` is the server-authoritative decision,
consulted both pre-approval (a fast-lane check) and at submission
(`submitPayable`). It returns `{ ok }` or a block with a category and reason:

1. **Circuit breaker open** → `TREASURY_REVIEW` — submissions paused.
2. **Provider unconfigured** → `PROVIDER_UNAVAILABLE`.
3. **Real provider, production not enabled** → `PROVIDER_UNAVAILABLE`.
4. **Mock provider in production** → `PROVIDER_UNAVAILABLE`.
5. **Provider health `DOWN`** → `PROVIDER_UNAVAILABLE`.
6. **Single-payout ceiling exceeded** → `TREASURY_REVIEW`.
7. **Daily aggregate ceiling would be exceeded** → `TREASURY_REVIEW`.

A gate block is a **delay, not a denial**. At submission the payout **stays
`PAYABLE`** with an advisory `exceptionCategory` and a customer-safe `UNDER_REVIEW`;
the durable worker resumes it automatically once the condition clears. No debit is
reversed, no eligibility is lost.

The `treasury preserves liability` torture test proves that opening the breaker
after approval leaves the payout `PAYABLE` with its `DEBIT` intact and the economic
state still `APPROVED` — the money is still owed, just not yet sent.

---

## The circuit breaker

`openCircuitBreaker` / `closeCircuitBreaker`:

- flip `circuitBreakerOpen`,
- append an immutable `payout_circuit_breaker_events` row (`OPEN`/`CLOSE`, reason,
  actor),
- write an audit entry (`payout_ops.circuit_breaker_opened` / `_closed`),
- publish `payout.circuit_breaker_opened` / `_closed`.

While open, `treasuryGate` blocks every submission with `TREASURY_REVIEW`; approved
payouts pile up as `PAYABLE` (owed). Closing it lets the worker drain them, each
still exactly-once on its stable idempotency key. The browser suite opens the
breaker (with an audited reason), confirms it reads `OPEN`, then closes it and
confirms submissions resume.

---

## RBAC

- **SUPPORT** reads treasury config and the console (read-only).
- **ADMIN** edits config and toggles the breaker (audited, with a reason).
- Enabling production and changing ceilings is an ADMIN action, audited.

The owner UI shows treasury controls as explicitly operational: *"Operational
controls, never trader eligibility. Opening the circuit breaker pauses new external
submissions; it never deletes requests, erases liabilities, rewrites paid history,
or makes anyone ineligible."*

---

## What treasury controls can never do

- Make a trader ineligible or reduce what they are owed.
- Reverse a `DEBIT` or rewrite `PAID` history.
- Enable real money movement implicitly — production is an explicit, audited switch,
  off by default, fail-closed until a provider is configured.
