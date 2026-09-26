# ACCOUNT STATE MACHINE

**Phase 2 — System-Wide Reconciliation. Audit-only.**

Baseline HEAD: `55df4c7` · Compiled 2026-09-25 from code trace (`account-service.ts`,
`account-rules.ts`, `packages/core/src/rules/rules.ts`, `commerce.ts`, `account-reset.ts`,
`account-inactivity.ts`, `payouts.ts`).

## Two-layer status model (the key invariant)

An account's effective state is governed by **two layers**:

1. **Rule-engine layer** — owns `accounts.status` / `accounts.ruleStatus` via
   `persistRuleState` (`account-rules.ts:227-250`). Statuses it produces (from
   `packages/core/src/rules/rules.ts:34` `AccountRuleStatus`): `ACTIVE`, `GOAL_REACHED`,
   `PASSED`, `FAILED`, `LOCKED`.
2. **Operator layer** — owns `accounts.adminHold` (a separate column). Values actually
   written: `null`, `PENDING`, `LOCKED`, `DISABLED`, `ARCHIVED`, `QUALIFIED`, `INACTIVE`.

**Invariant:** `persistRuleState` only overwrites the effective status when `adminHold IS
NULL` (`account-rules.ts:236`). So an operator hold takes precedence over rule-engine
transitions — the engine cannot silently un-hold an operator-held account.

## The actual set of status values written

| Status | Layer | Written by | In the declared `AccountStatus` type? |
|--------|-------|-----------|----------------------------------------|
| PENDING | both | provisioning | yes |
| ACTIVE | rule | default / activate / reset | yes |
| GOAL_REACHED | rule | rules engine (target hit, reqs unmet) | yes |
| LOCKED | rule/op | rules breach (recoverable) / lockAccount | yes |
| PASSED | rule | rules engine (all reqs met) / certify | yes |
| FAILED | rule | rules breach (terminal) | yes |
| DISABLED | op | disableAccount | yes |
| ARCHIVED | op | archiveAccount | yes |
| **COMPLETED** | op | `payouts.ts:587` (max payout cycles reached) | **NO — type is STALE** |
| **INACTIVE** | op | `account-inactivity.ts:171` (funded inactivity closure) | **NO — type is STALE** |

**Finding (STALE type):** `COMPLETED` and `INACTIVE` are real, written statuses but are
absent from the declared `AccountStatus` union (`account-service.ts:22-30`) and from
`TRADEABLE_STATUSES`. The type is stale relative to the code. Recorded in `KNOWN_ISSUES.md`
(HTF-8, P3).

## Transitions

Every administrative transition runs through `account-service.ts` `transition()` under an
advisory lock + `FOR UPDATE` + an `allowedFrom` guard + audit + event + outbox.

### Rule-engine transitions (trading)
- `ACTIVE ↔ GOAL_REACHED` — target hit but requirements unmet.
- `ACTIVE → PASSED` — all requirements met (terminal; closes lifecycle, event `account.passed`).
- `ACTIVE → FAILED` — breach, not recoverable (terminal; event `account.failed`).
- `ACTIVE → LOCKED` — breach, recoverable (e.g. daily lock).
- `LOCKED → ACTIVE` — lock expired.

Persisted by `persistRuleState`; audited via `engine-audit.ts` → `recordRuleOutcome`.

### EOD-trailing drawdown semantics (V1, locked Phase 3.5)

The single risk mechanic for every Happy Trader family is **EOD_TRAILING with lock at the
starting balance** (`trailingLockAtMicros = 0`; see `DECISION_LOG.md` DR-11). The engine
(`packages/core/src/rules/rules.ts`) enforces two distinct things that must not be conflated:

- **Floor movement (ratchet) — end of day only.** The drawdown floor advances **only** at the
  finalized EOD roll (`rollTradingDay`), computed off the finalized closing balance:
  `floor = max(currentFloor, floorFor(config, max(hwm, closingBalance)))`. `floorFor` caps the
  anchor at `startingBalance + trailingLockAtMicros`, so with `= 0` the floor rises toward — and
  **locks at — the starting balance**, then never moves again and never moves backward.
  Intraday unrealized gains never ratchet the floor (`advanceDrawdown` leaves the floor
  unchanged for `EOD_TRAILING`). *Worked example (CORE 50K, $2,000 DD): floor 48,000 → close
  51,000 ⇒ 49,000 → close 52,000 ⇒ 50,000 (locked) → HWM 55,000 ⇒ stays 50,000.*
- **Breach enforcement — intraday, on equity.** The authoritative breach metric is **equity**
  (`evaluateRules`: `remainingDrawdown = equityMicros − drawdownFloorMicros`; breach when
  `≤ 0`). The *current* floor is enforced continuously against equity intraday, but because the
  floor itself only ratchets at EOD, an unrealized intraday spike cannot tighten the floor
  against the trader.

**Post-payout:** a payout never resets or loosens `drawdownFloorMicros`; the withdrawable
amount is realized profit above the protected balance only (`payout-core.ts`
`grossWithdrawableMicros`), so a payout cannot push the account below its floor.

### Administrative transitions (`account-service.ts`)
- `activateAccount`: PENDING/DISABLED → ACTIVE (`account.activated`).
- `lockAccount`: ACTIVE/GOAL_REACHED/PENDING → LOCKED, adminHold LOCKED (`account.locked`).
- `unlockAccount`: LOCKED → (restore ruleStatus), clears hold (`account.unlocked`).
- `disableAccount`: PENDING/ACTIVE/GOAL_REACHED/LOCKED/PASSED/FAILED → DISABLED (`account.disabled`).
- `enableAccount`: DISABLED → (restore ruleStatus) (`account.enabled`).
- `archiveAccount`: → ARCHIVED, closes lifecycle (`account.archived`). **No `allowedFrom`
  guard** — any status, including already-ARCHIVED, can be re-archived (idempotent-ish but
  unguarded; recorded as a minor finding).

### Commerce / funding transitions (`commerce.ts`)
- `certifyEvaluation`: ACTIVE/GOAL_REACHED/PASSED → PASSED + adminHold QUALIFIED, inserts
  `account_qualifications` (ELIGIBLE), closes lifecycle PASSED (`evaluation.qualified`).
- `approveFunding`: qualification ELIGIBLE → FUNDED, provisions a FUNDED_SIM account, links
  `sourceQualificationId` / `sourceAccountId` (`funding.approved` + `account.funded`).
- `declineFunding`: → DECLINED (`funding.declined`).

### Reset transitions (two distinct concepts — see below)
- `resetAccount` (admin/engine, `account-service.ts:335-500`): any → ACTIVE, closes old
  lifecycle with endReason RESET, opens a new lifecycle (seq+1), resets balances/counters,
  clears adminHold (`account.reset`). **In-place** reuse of the same account row.
- RESET-purchase (`account-reset.ts`): creates a **new account** with `resetOfAccountId`
  pointing at the failed one; the failed account is never touched.

### Completion / closure
- `COMPLETED`: `payouts.ts:583-606` when the max payout cycle (5) is reached; publishes
  `account.completed` (drives the ACCOUNT_COMPLETED certificate).
- `INACTIVE`: `account-inactivity.ts:153-210` (funded-account inactivity closure, endReason
  INACTIVITY).

## Funding-state machine (`account_qualifications.fundingState`)

Schema declares: `ELIGIBLE | FUNDING_PENDING | APPROVED | DECLINED | FUNDED`.
**Actually written:** only `ELIGIBLE`, `FUNDED`, `DECLINED`.
`FUNDING_PENDING` and `APPROVED` are **DEAD enum values** — never produced. The `commerce.ts`
docstring references a `requestFunding` step that **does not exist**; `approveFunding` goes
straight ELIGIBLE → FUNDED. STALE-LEGACY doc + dead states (recorded in `KNOWN_ISSUES.md`).

## Permanent history / lifecycles

- `account_lifecycles`: one row per life, `seq`, `endReason` ∈ {RESET, PASSED, FAILED,
  ARCHIVED, INACTIVITY}. Orders/fills/trades are attributed by **time window**, never
  stamped or erased.
- `account_qualifications`: immutable evidence, unique `(accountId, lifecycleId)`.
- `accounts.resetOfAccountId`: links a reset-replacement account to its predecessor.

This gives a permanent, append-only account history — a real strength for the "permanent
history" leg of the Golden Path.

## Flagged ambiguities / possible defects (documented, not fixed)

1. **Active-slot counting excludes non-terminal states.** `account-limit.ts` counts only
   `['ACTIVE','PENDING']` toward the 5-active limit, so LOCKED (recoverable day-lock) and
   GOAL_REACHED accounts don't consume a slot. A trader with several day-locked or
   goal-reached accounts could purchase beyond the intended 5 live accounts. **Possible
   over-provisioning bug** — `KNOWN_ISSUES.md` HTF-6 (P2).
2. **STALE status type** — COMPLETED / INACTIVE missing from `AccountStatus` (HTF-8, P3).
3. **Dead funding states** — FUNDING_PENDING / APPROVED never written; docstring references
   a non-existent `requestFunding` (HTF-9, P3).
4. **`archiveAccount` has no `allowedFrom` guard** — minor; can re-archive.
5. **Two "reset" concepts** share the name (in-place `resetAccount` vs RESET-purchase that
   creates a new account). Not a bug; a naming overlap worth documenting.

## Side effects summary (per transition)

Every guarded transition writes: the `accounts` row (status/ruleStatus/hold/balances as
applicable), an append-only **audit** entry (actor/ip/requestId), a domain **event**, and an
**outbox** row that drives the read-model projection + cross-process socket fan-out +
downstream subscribers (certificates, notifications, recognition). Terminal PASSED/FAILED
and closures also write `account_lifecycles` / `account_qualifications`.

## PROVENANCE

Compiled from the commerce + account-lifecycle subagent trace, cross-checked against the
schema. Not re-executed as a live state-transition test in this phase; transition guards and
status writes are cited from source. No code was changed.
