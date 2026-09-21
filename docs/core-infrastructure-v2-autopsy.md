# Atlas — Core Infrastructure V2 architecture autopsy

Baseline commit `66e2aa8`. This is the "understand before rewriting" document the
milestone demands. Every claim below is a fact read from the code, with the
file it came from. Where the code already does the right thing, this says so;
where it will break at scale, this says that plainly.

## The 22 questions

### 1–8. Where financial truth is authoritative

| Concern | Authority | Where |
| --- | --- | --- |
| Balance | `accounts.balance_micros`, mutated only by atomic DB increments | `engine.ts` fill tx (`balanceMicros = balanceMicros + Δ`), account-service |
| Positions | `positions` table, one row per `(account_id, symbol)`, with a `version` column | `engine.ts` fill tx `onConflictDoUpdate` |
| Orders | `orders` table; `(account_id, client_order_id)` unique | `engine.ts` |
| Realized P&L | `accounts.realized_pnl_micros`, atomic increment on fill | `engine.ts` fill tx |
| Unrealized P&L | **Derived, never stored.** `engine.valuation()` marks open positions live | `engine.ts:504` |
| Drawdown | Derived in valuation from high-water mark / floor columns | `engine.ts` valuation |
| Risk rules | Pure functions in `@atlas/core` evaluated by the engine; `risk.ts checkOrder` gates entry | `trading/risk.ts` |
| Account status | `accounts.status` + `admin_hold` + `rule_status`; lifecycle transitions in account-service | `platform/account-service.ts` |

The rule that matters: **money is never re-derived in a route.** Balances and
realized P&L are stored and moved by atomic `col = col + Δ` statements; the
positions table stores cost basis, not a mark; unrealized P&L is computed on
demand by the engine and is `null` when the market cannot price a position.

### 9–11. Market prices: entry → candles → execution

- **Entry:** the one vendor-aware seam is `marketdata/provider.ts`
  (`MarketDataProvider`). Two implementations: `YahooDelayedProvider`
  (`mode: DELAYED`, ~601s measured delay, OHLCV + last, no book) and
  `ReplayProvider` (`mode: REPLAY`). Selection is by env
  (`MARKET_DATA_PROVIDER`), wired in `marketdata/bootstrap.ts`.
- **Candles:** `MarketDataService` routes provider events into per-symbol
  `CandleAggregator`s (`@atlas/core`). Base timeframe 1m; coarser frames folded.
  Only *closed* bars are cached (`historical_bars`), as integer ticks; replay is
  never cached.
- **Execution's marks:** the engine takes a read-only `MarketView`, not a
  provider. `markPrice(root)` prefers `quote.last`, falls back to a real book
  mid, never synthesizes one, returns `null` otherwise. A position also carries a
  `market_era`; a mark from a different era does **not** apply — the P&L reads
  unknown rather than wrong.

### 12–13. Account state to the UIs

- **Trader terminal:** `apps/web/src/trading/store.ts` holds a replica. It
  subscribes over WebSocket to `acct.<id>.{orders,positions,executions,trades}`
  (each schedules a debounced REST refresh) and applies `acct.<id>.pnl` frames
  directly (BAL/equity/UP&L/drawdown). Authoritative reads are 6 parallel REST
  GETs including `/pnl`.
- **Owner Control Center:** reads the same authoritative server state through the
  admin REST routes; Trading/Risk value accounts-with-exposure synchronously per
  request (the known V1/V2 scaling caveat).

### 14–15. In-process mutex and single-process assumptions

- **`KeyedMutex`** (`trading/mutex.ts`): a per-account in-memory async queue.
  **Every** engine mutation funnels through it — 11 `mutex.run(accountId, …)`
  callsites in `engine.ts` (submit, modify, cancel, cancelAll, flatten, reverse,
  set-protection, match, enforce-locked, the valuation/enforce passes). This is
  the single chokepoint that serializes read-decide-write on an account.
- **The assumption:** correctness of the *matching decision* (read
  position/orders in memory → decide fills → persist) depends on that in-memory
  lock. The persistence itself is one DB transaction with atomic increments, so
  a **partial** financial state cannot commit. But two processes each holding
  their own `KeyedMutex` can both read the same position and both decide to fill
  → **double fill**. Nothing at the database level currently prevents this.
- **`account-service.ts transition()`** (hold/reset/disable/enable/etc.) is a
  **non-transactional read-modify-write**: `load()` → check `allowedFrom` →
  `update` → `recordAudit` → `events.publish`, each auto-committed separately. It
  takes **no lock at all**, so it races both other transitions and engine fills
  (the owner-reset-vs-trader-fill race), and a crash mid-sequence can leave a
  state change unaudited.
- Other per-process state the engine leans on: `this.working` / `this.track`
  coalescing maps — lost on restart, not shared across processes.

### 16. Redis responsibilities

**None.** Redis is not connected anywhere. The only reference is an env default
(`REDIS_URL`); there is no `ioredis`/`new Redis`/`createClient` in the tree. No
cache, no pub/sub, no locks, no sessions, no financial truth in Redis. "Redis
failure" therefore cannot corrupt financial state — because nothing depends on
it. (This is a de-scoping fact for the milestone's Redis-failure phase.)

### 17. PostgreSQL responsibilities

Everything durable and authoritative: accounts, orders, executions, positions,
trades, the audit log (hash-chained, append-only by trigger), `account_events`
(monotonic per-account seq stream for WS recovery), `domain_events` (outbox),
product versions/drafts, historical bars. Cross-process coordination that exists
today is a **Postgres transaction-scoped advisory lock** in `recordAudit`
(`pg_advisory_xact_lock(chainKey)`) so two writers cannot fork the hash chain —
the precedent this milestone extends to account mutation.

### 18. Outbox / event responsibilities

- `domain_events` table with `delivered_at`, `attempts`, `last_error`, and an
  `undelivered` index — clearly built for a drain worker.
- `events.publish(db, event)` writes the outbox row **and** synchronously calls
  in-process subscribers (errors swallowed).
- **Two gaps:** (a) publish is **not** in the same transaction as the mutation
  (caller passes the top-level `db`, so the row and the state change are separate
  auto-commits — a crash between them can orphan or drop an event); (b) there is
  **no delivery worker** — `pendingEvents`/`markDelivered` are defined but never
  called, `delivered_at` is never set, and no runtime `events.subscribe`
  handlers are registered. Domain events are, in practice, write-only. The only
  reader is an admin reporting query.

### 19. WebSocket responsibilities

`ws/gateway.ts` (`MarketDataGateway`, raw `ws`). Publishes market data and
per-account trading streams, sourced **directly from the in-process engine's
`onChange`/`onValuation` callbacks** — not from Redis, not from the outbox.
Subscriptions are authorized per user + per account (`mayFollowAccount` queries
`accounts WHERE id AND user_id`), capped at 64, with snapshot + resume-by-seq.

### 20. Existing provider abstractions

- **Market data: present.** `MarketDataProvider` + `DescribableProvider` with a
  real `ProviderCapabilities` shape (`providesTrades/Quotes/TopOfBook/Depth/
  Ohlcv`, `history[]`) and a normalized `ProviderEvent` union
  (`quote|trade|bar|depth|status`). Phase 4 of this milestone is mostly *already
  done*; what it lacks is a formal normalized-event type layer and an explicit
  capability-discovery contract documented as such.
- **Execution: absent.** There is no `ExecutionProvider`/broker/gateway seam.
  The engine *is* the (simulated) execution venue and writes straight to
  Postgres. The only injected abstraction is the read-only `MarketView`.

### 21. Contract / instrument model

`@atlas/contracts InstrumentSpec` is keyed by **root** (`"NQ"`) and is the key
used everywhere. `@atlas/instruments contracts.ts` derives the front-month
**`ActiveContract`** (`code: "NQZ26"`, month/year, lastTradingDay, rollDate) from
the listing cycle + roll rule — but this is **derivation for display only**. No
order, execution, position, or trade stores a contract code.

### 22. Where root symbols are persisted where a contract may later be required

Every symbol column is `varchar(12)` storing the **root**:
`orders.symbol`, `executions.symbol`, `positions.symbol`, `trades.symbol`,
plus UI/meta tables (`chart_states`, `drawings`, `market_data_meta`,
`historical_bars`). **An `NQZ26` fill and an `NQH27` fill are today
indistinguishable in the database** — both persist `"NQ"`. This is the contract
-identity gap Phase 1 closes for the execution-bearing tables.

## What this means for the milestone

The good news the autopsy found:

- Money already moves by atomic DB increments inside one transaction — no
  partial financial state within a process.
- Idempotency is real: `orders(account_id, client_order_id)` unique + a submit
  pre-check; provisioning idempotency keys with request-hash conflict detection.
- The audit chain is hash-linked, append-only by trigger, advisory-locked, and
  verifiable — and it already demonstrates the cross-process advisory-lock
  pattern.
- `market_era` already prevents cross-market P&L contamination.
- SMOOTH interpolation is strictly visual and cannot touch fills/P&L/history.
- A capability-based market-data provider seam already exists.
- Redis holds nothing, so it cannot lose financial truth.

The real work this milestone must do:

1. **Contract identity** — first-class `RootInstrument` / `TradableContract` /
   `ContinuousSeries` / `ProviderInstrument` types, a `ContractResolver`
   boundary, and **persist the tradable-contract code** on the execution-bearing
   tables so `NQZ26` ≠ `NQH27` survives persistence.
2. **Distributed correctness** — back the in-process mutex with a **Postgres
   advisory lock** so the read-decide-write critical section serializes across
   processes, and make `account-service transition()` transactional and lock-
   guarded so owner and trader actions cannot race. Formalize the existing
   account `seq` as the authoritative, monotonic `stateVersion`.
3. **Execution provider abstraction** — the seam that does not yet exist, with
   the current engine wrapped as `AtlasSimulationExecutionProvider`.
4. **Event reliability** — let the outbox write **in the mutation's
   transaction**, and either add the delivery worker or document it as deferred;
   keep consumers idempotent.
5. **Honest reporting** of everything measured vs. SIMULATED vs. NOT RUN.

Non-issues this autopsy retires: a Redis-failure financial-corruption matrix
(nothing is in Redis), and building the market-data provider seam (it exists).
