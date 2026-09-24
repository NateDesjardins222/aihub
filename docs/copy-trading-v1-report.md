# Atlas Native Copy Trading V1 — Final Report

**Milestone 3.** One Happy Trader customer designates ONE leader account and UP
TO FOUR follower accounts and trades them together, natively, from Atlas. The
model is exactly: **one user intent → one copy intent → many independent
account executions**, all driven through the EXISTING authoritative Atlas
execution / risk / position / P&L / bracket engine. No second trading engine was
built; no client holds trading authority.

- **Starting HEAD:** `9a0e06d` (Milestone 2 — Customer Portal V1, final).
- **Ending HEAD:** `08fd9f4` (this report is committed on top).
- **Branch:** `claude/futures-trading-simulator-v8qefu`.
- **Migration:** `0021_copy_trading` (journal idx 21), applied to `atlas` and
  `atlas_test`.

---

## 1. Non-negotiables — how each is met

| # | Requirement | How it is satisfied |
|---|---|---|
| a | Orchestrate the existing engine; never a second engine | Every child execution (leader included) goes through `execution.submitOrder / modifyOrder / cancelOrder / flatten` — the same `ExecutionProvider` the solo order ticket uses. `copy-orchestrator.ts` fills nothing, computes no money, prices nothing. |
| b | Never bypass ownership, lifecycle, risk, MLL, contract limits, instrument permissions, validation, funded/eval rules, server authority | Each child runs that account's full risk pipeline under its own `KeyedMutex`. A child rejection (e.g. `MAX_CONTRACTS_EXCEEDED`, `ACCOUNT_LOCKED`) is recorded on that child alone. |
| c | Same-owner only; same-owner copying allowed, never flagged as fraud | Groups, followers and every action are owner-scoped (`ownedGroup`/`ownedAccount`); a group can only reference the caller's own accounts. Cross-customer copying is structurally impossible. |
| d | Five-active-account invariant preserved | A group only ever references the trader's own tradeable accounts, of which the platform already guarantees ≤ 5. Max group = 1 leader + 4 followers (`MAX_FOLLOWERS = 4`). |
| e | Doc-first with commit checkpoints CT-A..CT-N | See §3. CT-A landed three design docs before any code. |
| f | Sizing Same / Multiplier / Fixed, deterministic floor rounding, zero→skip | `copy-sizing.ts`: multiplier carried in integer thousandths, `floor(leaderQty × milli / 1000)`, a computed zero is an explicit SKIP with a reason. Pure, no floats. |
| g | Same-instrument only (no mini↔micro conversion in V1) | Children copy the leader's symbol verbatim; no instrument translation exists. |
| h | Topology one-leader→N, loop/chain prevention | Partial unique index `copy_groups_active_leader_key` + `assertAccountFree`: an account cannot be leader and follower, nor belong to two active groups. |
| i | Idempotency + concurrency (exactly-once logical intent) | Group-scoped unique `idempotency_key` collapses retries to one intent (`onConflictDoNothing` → replay returns the same children); deterministic `clientOrderId = cpy-<intentId>-<accountId>` collapses to one order per account, with the engine's own unique index as backstop. Proven under 8 concurrent identical submits (CT-L). |
| j | Partial success (never roll back valid children) | Fan-out is `Promise.all` of independent child executions; a rejection is recorded on its child and the others stand. |
| k | Parallel fan-out | `Promise.all(targets.map(executeChild))`. |
| l | Brackets copy OFFSETS not absolute prices; per-account OCO | Bracket offsets (TICKS/POINTS/DOLLARS) are recomputed per follower quantity and each account's protective legs are built from its OWN fill, sharing its OWN `ocoGroupId`. Proven: three distinct OCO groups for a three-account group (CT-L). |
| m | Divergence (SYNCED/DIVERGED/PAUSED/DISABLED) + explicit reviewed resync | `copy-divergence.ts` DERIVES status from live positions vs sizing-adjusted expected; resync is an explicit owner action that closes gaps through the normal pipeline. |
| n | Pause (never flattens) / resume (revalidates) / disable / flatten group + isolated single-account flatten | `pauseGroup` sets status only; `resumeGroup` revalidates the leader; `flattenCopyGroup` flattens each member independently; a single account is flattened via the ordinary `/positions/:symbol/flatten`. |
| o | Leader breach → pause group + require new leader (no silent promotion); follower breach → isolate, continue | `copy-breach.ts` subscribes to `account.failed`/`account.locked` and pauses any group that account LEADS; the owner must choose a new leader. A follower breach needs no reaction — its own risk pipeline rejects its child orders, isolating it while the group keeps trading. |
| p | Realtime, restart recovery, auditability, owner visibility, telemetry | Child fills publish on the existing per-account WS channels; intents/children are durable rows re-read on load; `recordAudit` + domain events on every state change; owner 360 surfaces groups (CT-K). |
| q | Extensive tests + real-browser acceptance + regression | 45 server tests (unit/invariant/concurrency/torture) + a real-browser acceptance spec + a non-copy regression check. See §4. |
| r | Final report | This document. |

**DO-NOT list** — all honored: no live capital / external brokerage / TradeSea,
no new instruments, no market-data provider expansion, no backtesting, no Atlas
redesign, no production credentials, and no silent clamp / resync / leader
promotion / flatten-on-pause.

---

## 2. Architecture

```
        ONE USER INTENT (order ticket, leader account selected)
                              │
                     POST /api/v1/copy/groups/:id/intents
                              │
                    submitCopyIntent (copy-orchestrator)
             ┌────────────────┼───────────────────────────┐
   record ONE copy_intent   size each follower       fan out in parallel
   (group-scoped idem key)  (copy-sizing, floor)     Promise.all(executeChild)
                              │                            │
                              ▼                            ▼
                    one copy_child per account   execution.submitOrder(account)
                    (unique per intent,account)  → the EXISTING risk+exec engine
                                                   under that account's own lock
```

The orchestrator is a *coordinator*, not an engine: it records the intent, sizes
each follower, writes one child per account, and calls the same execution seam
the solo ticket uses. Risk, MLL, contract limits, brackets, OCO, realtime
updates and P&L all come from the one authoritative engine, unchanged.

### Files

**Server**
- `db/schema.ts` + `drizzle/0021_copy_trading.sql` — `copy_groups`,
  `copy_followers`, `copy_intents`, `copy_children` (+ the topology partial
  unique index).
- `platform/copy-sizing.ts` — pure deterministic sizing (floor, zero→skip).
- `platform/copy-groups.ts` — owner-scoped group/follower CRUD, eligibility,
  topology, lifecycle, `systemPauseGroupsLedBy`.
- `platform/copy-orchestrator.ts` — fan-out submit + modify/cancel/flatten +
  resync order, idempotent & partial-success.
- `platform/copy-divergence.ts` — derived sync view + `executeResync`.
- `platform/copy-breach.ts` — bystander subscriber: leader breach → group pause.
- `platform/owner-customer.ts` — copy groups in the operator 360 (`customerCopyGroups`).
- `trading/order-levels.ts` — shared tick/offset conversion (extracted, reused).
- `http/routes/copy.ts` — `/api/v1/copy/*`, all `requireUser` + owner-scoped.
- `http/app.ts` — registers the routes and attaches the breach handler.

**Web**
- `trading/copy-api.ts` — REST client for `/api/v1/copy/*`.
- `trading/copy-store.ts` — replica of groups/eligibility/sync + `activeLeaderGroupFor`,
  `previewFollowerQty` (display-only sizing mirror).
- `panels/CopyPanel.tsx` + `panels/Copy.css` — the native control (setup,
  followers, sizing, status, divergence, pause/resume/resync/flatten).
- `panels/OrderTicket.tsx` — copy-aware: "COPY ACTIVE · N accounts" banner, a
  per-account fan-out preview, and routing the submit through the group intent
  endpoint when the selected account leads an ACTIVE group. Non-copy submission
  is byte-identical to before.
- `admin/pages/CustomersPage.tsx` — copy groups in the customer 360.

---

## 3. Checkpoints

| CT | Commit | Content |
|----|--------|---------|
| A | `25b570c` | Domain model, execution semantics, failure-modes docs |
| B | `0694ff8` | Schema + migration 0021 |
| C/D | `dcbf8c1` | Sizing + copy-group domain |
| E | `369cb40` | Copy-intent fan-out orchestrator |
| F/H | `ad882a8` | modify/cancel/flatten + divergence/resync |
| J (server) | `1131e7d` | HTTP surface `/api/v1/copy/*` |
| J (web) | `6bd58d4` | Web UI + order-ticket fan-out awareness |
| I | `6d5ee46` | Leader-breach pause + follower isolation |
| K | `95eedf0` | Owner visibility — copy groups in the customer 360 |
| L | `d842b30` | 1-leader-4-follower concurrency + torture suite |
| M | `08fd9f4` | Real-browser acceptance + regression |
| N | (this doc) | Final report + validation |

---

## 4. Verification

### Server tests — 45/45 green

| Suite | Tests | Proves |
|---|---|---|
| `copy-sizing.test.ts` | 9 | SAME/MULTIPLIER/FIXED, floor rounding, zero→skip |
| `copy-groups.test.ts` | 12 | ownership/IDOR, topology (loop/chain), eligibility, lifecycle, MAX_FOLLOWERS |
| `copy-orchestrator.test.ts` | 4 | fan-out fills through the real engine, idempotent replay, partial success |
| `copy-actions.test.ts` | 3 | modify/cancel propagation, group flatten, divergence→resync |
| `copy-breach.test.ts` | 4 | leader fail/lock → group pause (no promotion), submit-time guard, follower isolation |
| `copy-torture.test.ts` | 5 | see below |
| `copy.routes.test.ts` | 8 | HTTP surface: owner-scoping, IDOR, validation, fan-out wiring, paused-refusal |

**Torture (CT-L), scripted market, deterministic — the authoritative execution
proof:** 1 leader + 4 followers with mixed MULTIPLIER sizing; deterministic
per-account fills (leader 4 → ×1=4, ×0.5=2 floor, ×2=8, capped follower
REJECTED and isolated, valid children not rolled back); a ×0.001 follower is an
explicit SKIP with no order row; 8 concurrent identical submits collapse to ONE
intent and ONE order per account (position 2, not 16); a bracketed entry gives
each account its OWN two protective OCO legs with three distinct OCO groups;
balances are unmoved while positions are open (no money leakage); group flatten
closes all five independently; and a non-member account is never touched.

### Typecheck / build
- `apps/server` `tsc --noEmit`: clean.
- `apps/web` `tsc --noEmit`: clean.
- `apps/web` `vite build`: succeeds (pre-existing chunk-size advisory only).

### Migrations
- `0021_copy_trading` present in the journal and applied to both `atlas` and
  `atlas_test` (4 `copy_*` tables in each).

### Real-browser acceptance (CT-M)
`tests/browser/copy-acceptance.spec.mjs` drives the ACTUAL terminal against the
real server, database and engine (1 leader + 4 followers). Consistently
verified, across runs, with screenshots:

- five eligible accounts; a group created with an owned leader; four followers
  added; the CopyPanel renders leader + followers + ACTIVE status;
- the order ticket shows **COPY ACTIVE · 5 accounts** with the per-account
  fan-out preview when the leader account is selected;
- **resync** is accepted through the normal pipeline;
- **pause** never flattens and the ticket stops showing COPY ACTIVE while paused;
- **flatten-all** is accepted and the group ends flat;
- **regression:** a non-copy (practice) account shows NO copy banner and its
  order is isolated — no copy-group account is changed by it;
- no unexpected UI console errors.

In fill-capable runs the spec additionally observed the full fan-out (all four
followers matched the leader at SAME sizing), divergence detection after a
manual single-follower flatten, and the resynced follower returning in line.

**Environmental note on fills.** The acceptance's fan-out *fill* assertions
depend on the replay market simulator delivering fills to resting market orders.
In this long-lived shared dev session that delivery became unreliable late in
the run — a resting market order (copy OR a plain single-account order, and an
API-submitted order as well) sometimes rests without a matching event, so a
given browser run may not fill. This is a market-simulation/clock artifact of
the environment, not copy-trading logic, and is the same class of replay-era
flakiness the browser harness already documents (see `tests/browser/harness.mjs`
D-009/D-017 market-era notes). The authoritative, deterministic proof that
fan-out, sizing, partial-success isolation, exactly-once concurrency,
bracket/OCO independence, flatten-all and zero cross-account leakage all behave
correctly is the scripted-market torture suite (CT-L), which does not depend on
the simulator's timing and passes 5/5.

---

## 5. Sound engineering decisions

- **Integer-thousandths multiplier.** Sizing is exact integer math; no float
  nondeterminism, no alternating rounding — always floor, never above the
  leader's intent.
- **Deterministic client order id + group-scoped idempotency key.** Two layers of
  exactly-once: one intent per logical action, one order per account, with the
  engine's unique index as a final backstop.
- **Divergence is derived, never stored.** The sync view is computed from live
  positions vs the sizing-adjusted expectation, so it cannot drift from reality;
  resync is always an explicit, reviewed owner action.
- **Breach reaction is a bystander subscriber**, exactly like `engine-audit` and
  `commerce-certify` — the execution engine and account lifecycle know nothing
  about copy trading, so leader-breach pause and follower isolation are added
  without touching the matcher.
- **Order-ticket copy-awareness is additive.** When the selected account is not
  an ACTIVE leader, the submission path is byte-identical to before, which is
  what keeps non-copy trading unaffected (verified by the regression check).
- **The order-ticket manage buttons (Close/Reverse/partials/protect) act on the
  selected account only;** group-wide actions (flatten-all, pause, resync) live
  in the CopyPanel. This keeps per-account semantics unambiguous in V1; the
  divergence view surfaces any gap a manual single-account action creates.

---

## 6. Follow-ups (out of V1 scope)

- Mini↔micro sizing conversion (explicitly excluded from V1).
- A UI affordance to make the ticket's Close/Reverse group-aware (currently
  leader-only by design; group flatten covers the group-wide case).
- Copy-trading telemetry dashboards for the owner beyond the 360 read model.
