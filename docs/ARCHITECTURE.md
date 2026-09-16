# Atlas Futures Terminal — Architecture

> **Original work.** No TradingView or Topstep source code, visual assets, logos, trademarks
> or branding are reproduced. Functionality, workflows and interaction concepts are
> re-implemented from documented behaviour. See `docs/IP-COMPLIANCE.md`.

Status legend used throughout this repository:

| Tag | Meaning |
| --- | --- |
| `IMPLEMENTED BY US` | Original code in this repository, working and tested. |
| `OSS DEPENDENCY` | Third-party open-source library used under a permissive licence. |
| `LICENSED / EXTERNAL` | Requires a commercial licence, API credential or vendor agreement we do **not** possess. Architected for, never claimed as implemented. |

---

## 1. Current repository assessment

The repository `NateDesjardins222/aihub` was **completely empty** at the start of this work —
a bare `.git` directory on branch `claude/futures-trading-simulator-v8qefu` with zero commits,
no source files, no package manifest, no CI, no history. There is no legacy code to preserve,
migrate or work around. Everything is greenfield.

Verified host capabilities (probed, not assumed):

| Capability | Result |
| --- | --- |
| Node.js | v22.22.2 |
| pnpm | 10.33.0 |
| PostgreSQL | 16.13 — server present, started |
| Redis | 7.0.15 — server present, started |
| Docker | present |
| Outbound HTTPS | working through agent proxy |
| Real futures OHLCV | reachable — CME/COMEX/NYMEX continuous-front-month bars with exchange timestamps |

---

## 2. Technology stack

TypeScript end to end, in strict mode, with the trading math isolated into pure,
dependency-free packages so it can be exhaustively unit-tested without a database, a
socket or a browser.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`) | One type system across engine, API and UI; contracts cannot drift. |
| Monorepo | pnpm workspaces + Turborepo-free plain scripts | Minimal moving parts; workspace protocol gives real package boundaries. |
| Server | Fastify 5 | Fast, schema-first, first-class JSON-schema validation, good WS story. |
| Realtime | `ws` (raw WebSocket) + custom framed protocol | Sequence numbers, heartbeats and snapshot/delta recovery need protocol control that socket.io hides. |
| Database | PostgreSQL 16 via Drizzle ORM | Real transactions, `SELECT … FOR UPDATE`, exact `numeric`, generated migrations, no runtime magic. |
| Money | Integer arithmetic (`bigint` micro-dollars / integer ticks) | Floating-point dollars are disqualifying in a P&L engine. |
| Cache / pubsub | Redis 7 (`ioredis`) | Quote fan-out, per-account locks, hot snapshots. Never the source of truth for financial state. |
| Auth | Argon2id + JWT access token + rotating DB-backed refresh token | Standard, revocable, no third-party dependency. |
| Frontend | React 19 + Vite 8 | Fast HMR; React used for *chrome only*, never for tick rendering. |
| App state | Zustand + external event bus | Ticks bypass React entirely; only committed trading state re-renders. |
| Chart engine (Phase 1) | `lightweight-charts` 5.x — Apache-2.0 | Genuinely open-source and free to use. Canvas renderer, plugin/primitive API sufficient for order lines, position lines and a custom drawing layer. |
| Chart engine (Phase 2 option) | TradingView Advanced Charts | `LICENSED / EXTERNAL` — see §7. |
| Testing | Vitest | Same runtime as source; fast; good fake-timer support for race tests. |
| Validation | Zod 4 | One schema source shared by HTTP, WS and the client. |
| Time | Luxon | Exchange-timezone and session-boundary arithmetic, DST-correct. |

### Explicitly rejected

- **Floating-point dollars.** All money is integer micro-dollars (`1e-6 USD`); all prices are
  integer ticks relative to an instrument's tick size.
- **Client-side fills.** The browser never decides anything financial.
- **Redis as system of record.** Redis is a cache and a bus. Postgres is the truth.
- **`Math.random()` price generation.** Anywhere. The repository has a lint rule and a test
  that fails the build if `Math.random` appears in any market-data path.

---

## 3. Complete architecture

```
                    ┌──────────────────────────────────────────────┐
                    │  MARKET DATA PROVIDERS (pluggable)           │
                    │  • YahooDelayedProvider   (real, delayed)    │
                    │  • ReplayProvider         (recorded real)    │
                    │  • DatabentoProvider      LICENSED/EXTERNAL  │
                    │  • CmeDirectProvider      LICENSED/EXTERNAL  │
                    └───────────────────┬──────────────────────────┘
                                        │ vendor-shaped payloads
                    ┌───────────────────▼──────────────────────────┐
                    │  NORMALIZATION LAYER                         │
                    │  vendor → NormalizedQuote / Trade / Bar       │
                    │  exchange timestamps preserved, ticks snapped │
                    └───────────────────┬──────────────────────────┘
                    ┌───────────────────▼──────────────────────────┐
                    │  MARKET EVENT BUS  (in-proc + Redis pub/sub)  │
                    │  monotonic seq, dedupe, out-of-order drop     │
                    └──────┬─────────────────────┬──────────────────┘
                           │                     │
            ┌──────────────▼───────┐   ┌─────────▼────────────────┐
            │ TICK / QUOTE STORE   │   │ CANDLE AGGREGATOR        │
            │ top-of-book, last,   │   │ 18 timeframes, session-  │
            │ staleness clock      │   │ aware, idempotent        │
            └──────────┬───────────┘   └─────────┬────────────────┘
                       │                         │
                       │                    ┌────▼─────────────────┐
                       │                    │ BAR CACHE / HISTORY  │
                       │                    └────┬─────────────────┘
        ┌──────────────▼─────────────────────────▼─────────────────┐
        │  SIMULATION EXECUTION ENGINE   (authoritative, server)    │
        │  per-account serialized mutex → fill model → OCO/bracket  │
        └──────────────┬───────────────────────────────────────────┘
        ┌──────────────▼───────────────────────────────────────────┐
        │  POSITION + P&L ENGINE   (instrument-spec driven)         │
        └──────────────┬───────────────────────────────────────────┘
        ┌──────────────▼───────────────────────────────────────────┐
        │  RISK / DRAWDOWN / CONSISTENCY ENGINES                    │
        └──────────────┬───────────────────────────────────────────┘
        ┌──────────────▼───────────────────────────────────────────┐
        │  ACCOUNT STATE  +  IMMUTABLE AUDIT LOG  (PostgreSQL)      │
        └──────────────┬───────────────────────────────────────────┘
        ┌──────────────▼───────────────────────────────────────────┐
        │  WS GATEWAY — snapshot + sequenced deltas, heartbeats     │
        └──────────────┬───────────────────────────────────────────┘
        ┌──────────────▼───────────────────────────────────────────┐
        │  BROWSER — Chart · DOM · Order Panel · Activity Panel     │
        │  ticks → event bus → chart API   (never React state)      │
        └───────────────────────────────────────────────────────────┘
```

### Authority boundary

Everything above the WS gateway is authoritative. The browser holds a *replica*. On any
disconnect the replica is discarded and rebuilt from a server snapshot. The client may
*request* (submit / modify / cancel); it may never *assert* (filled / P&L / balance / status).

---

## 4. Directory structure

```
aihub/
├── package.json                    pnpm workspace root
├── docs/
│   ├── ARCHITECTURE.md             this file
│   ├── IP-COMPLIANCE.md            what we did and did not reproduce
│   └── milestones/                 per-milestone status reports
├── packages/
│   ├── contracts/                  shared types + Zod schemas + WS protocol
│   ├── instruments/                centralized instrument specification registry
│   └── core/                       PURE engines — no I/O, no framework
│       └── src/
│           ├── money/              integer tick & micro-dollar arithmetic
│           ├── candles/            OHLCV aggregation, session boundaries
│           ├── execution/          order lifecycle, fill models, OCO, brackets
│           ├── position/           weighted average entry, reduce/close/reverse
│           ├── pnl/                realized / unrealized / equity
│           ├── risk/               pre-trade checks
│           ├── drawdown/           static / intraday-trailing / EOD-trailing
│           └── consistency/        profit-concentration rules
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── db/                 Drizzle schema + migrations + repositories
│   │       ├── marketdata/         providers, normalization, bus, store
│   │       ├── trading/            engine host, account actors, persistence
│   │       ├── http/               REST routes
│   │       ├── ws/                 gateway, channels, sequencing, recovery
│   │       └── auth/               argon2 + JWT + refresh rotation
│   └── web/
│       └── src/
│           ├── chart/              ChartAdapter + lightweight-charts impl
│           │   ├── drawings/       drawing tool framework
│           │   └── indicators/     indicator framework
│           ├── dom/                price ladder
│           ├── orders/             order panel, chart trading
│           ├── panels/             positions / orders / trades / accounts / quotes
│           ├── layout/             multi-chart workspaces, link groups
│           └── state/              event bus, stores, WS client
```

---

## 5. Database schema (PostgreSQL)

Financial columns are `numeric` or `bigint`; never `float`. Every mutating trading write is
inside a transaction that also appends to the audit log.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `users` | identity | `id`, `email` (unique), `password_hash`, `created_at` |
| `refresh_tokens` | rotating sessions | `id`, `user_id`, `token_hash`, `expires_at`, `revoked_at` |
| `rule_templates` | configurable prop products | `account_size`, `profit_target`, `max_loss`, `drawdown_type`, `daily_loss_limit`, `consistency_threshold`, `max_contracts`, `min/max_trading_days`, `payout_rules` jsonb |
| `accounts` | trading accounts | `user_id`, `rule_template_id`, `status`, `starting_balance`, `balance`, `high_water_mark`, `realized_pnl`, `fees_paid`, `seq` |
| `orders` | order lifecycle | `id`, `account_id`, `client_order_id` (idempotency, unique per account), `symbol`, `side`, `qty`, `filled_qty`, `type`, `limit_ticks`, `stop_ticks`, `tif`, `status`, `oco_group_id`, `parent_order_id`, `bracket_role`, `trail_ticks`, `version` |
| `executions` | immutable fills | `order_id`, `account_id`, `qty`, `price_ticks`, `fees`, `exec_time`, `seq` |
| `positions` | authoritative positions | `account_id`, `symbol` (unique together), `side`, `qty`, `avg_entry_ticks`, `realized_pnl`, `version` |
| `trades` | closed round-trips | `entry_time`, `exit_time`, `entry_ticks`, `exit_ticks`, `gross_pnl`, `fees`, `net_pnl` |
| `daily_account_stats` | per trading day | `account_id`, `trade_date`, `starting_balance`, `ending_balance`, `realized_pnl`, `high_equity`, `low_equity`, `fees`, `trade_count` |
| `account_events` | immutable audit | `account_id`, `seq`, `type`, `prev_state`, `new_state`, `request`, `source`, `created_at` |
| `risk_events` | rejections & breaches | `account_id`, `order_id`, `rule`, `reason_code`, `detail` |
| `layouts` | workspaces | `user_id`, `name`, `config` jsonb, `is_default` |
| `chart_states` | per-chart settings | `layout_id`, `chart_id`, `symbol`, `timeframe`, `chart_type`, `settings` |
| `drawings` | persisted drawings | `layout_id`, `chart_id`, `symbol`, `tool`, `points`, `style`, `z_index`, `locked`, `hidden` |
| `chart_indicators` | persisted studies | `layout_id`, `chart_id`, `type`, `inputs`, `style`, `pane`, `order_index` |
| `market_data_meta` | feed provenance | `symbol`, `provider`, `mode` (DELAYED/REALTIME), `delay_seconds`, `last_event_at` |

Concurrency: per-account `SELECT … FOR UPDATE` plus an in-process async mutex keyed by
account id, so OCO sibling cancellation and position mutation are atomic. `client_order_id`
gives submission idempotency. `orders.version` gives optimistic-concurrency protection
against stale drag-modify requests.

---

## 6. Market-data architecture

`MarketDataProvider` is the only vendor-aware interface in the system:

```ts
interface MarketDataProvider {
  readonly id: string;
  readonly mode: 'DELAYED' | 'REALTIME' | 'REPLAY';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
  getHistoricalBars(req: HistoricalBarsRequest): Promise<NormalizedBar[]>;
  getQuote(symbol: string): NormalizedQuote | null;
  getTrades(symbol: string): NormalizedTrade[];
  getDepth(symbol: string): NormalizedDepth | null;   // null ⇒ genuinely unavailable
  getConnectionStatus(): ConnectionStatus;
}
```

**Phase 1 provider — `IMPLEMENTED BY US`, real data.** A delayed provider that reads genuine
exchange-sourced OHLCV for the CME/COMEX/NYMEX front-month continuous contracts. Bars carry
exchange timestamps and the exchange's own timezone. Nothing is synthesized. The connection
banner reports `DELAYED` with the measured delay in seconds, and never says `REAL-TIME`.

**Depth.** The Phase 1 feed has no Level 2. `getDepth()` returns `null`, the DOM renders
top-of-book only, and it displays **"LEVEL 2 UNAVAILABLE — TOP OF BOOK ONLY"**. Fabricating
ladder rows is prohibited by the DOM component's own contract.

**Staleness.** The quote store tracks the age of the newest exchange timestamp per symbol.
Past a configurable threshold the risk engine rejects new orders with
`MARKET_DATA_STALE` and the UI shows **MARKET DATA STALE — ORDER ENTRY DISABLED**.
Existing positions and account state are untouched.

**Ordering.** Every normalized event carries `(symbol, exchangeTs, providerSeq)`. The bus
drops duplicates and refuses to regress a symbol's clock, so reconnect replays cannot
double-count volume or resurrect a closed candle.

**Later feeds — `LICENSED / EXTERNAL`.** Databento, CME MDP 3.0, Rithmic, dxFeed and
Polygon futures all fit this interface unchanged. Connecting one is a provider module plus
credentials; no trading code changes.

---

## 7. Charting approach

A `ChartAdapter` interface separates *trading* from *rendering*:

```ts
interface ChartAdapter {
  setChartType(t: ChartType): void;
  setTimeframe(tf: Timeframe): void;
  applyHistory(bars: Bar[]): void;
  applyLiveBar(bar: Bar): void;            // called off the React tree
  addOrderLine(o: OrderLineSpec): OrderLineHandle;   // draggable
  addPositionLine(p: PositionLineSpec): PositionLineHandle;
  priceToY(p: number): number; yToPrice(y: number): number;
  timeToX(t: number): number; xToTime(x: number): number;
  screenshot(): Promise<Blob>;
  // …
}
```

- **Phase 1 implementation — `OSS DEPENDENCY` + `IMPLEMENTED BY US`.**
  `lightweight-charts` (Apache-2.0) provides the candle/bar/line/area renderer, scales and
  crosshair. *Everything trading-related and every drawing tool is our own code* built on its
  primitive/plugin API: order lines, drag handles, position lines, risk read-outs, the drawing
  framework, the indicator framework, countdown, session shading.
- **Phase 2 option — `LICENSED / EXTERNAL`.**
  TradingView Advanced Charts is a commercial product requiring a signed licence and a
  library bundle we do not have. We provide `TradingViewAdvancedChartsAdapter` as a
  **stub implementing the same interface**, plus the `Datafeed` and `Broker` shapes their
  documented integration expects. It is inert until a licensee drops in the bundle. We do not
  and will not copy their source.

Chart types by phase: Phase 1 ships Candles, Hollow Candles, Bars, Line, Line-with-markers,
Area, Baseline and Heikin Ashi (computed by us). Renko, Kagi, Line Break, Point & Figure and
High-Low are architected as `BarTransform` plug-ins — the transform interface exists so they
are additive, not a rewrite.

---

## 8. Simulation execution architecture

The engine is a server-side actor system. One logical actor per account; all mutations for an
account are serialized through its mutex, so no two events can interleave inside a position
update or an OCO resolution.

```
submit/modify/cancel ─┐
                      ├─► AccountActor (serialized)
market event ─────────┘        │
                               ├─ 1. risk pre-checks
                               ├─ 2. evaluate triggers (stop/trail activation)
                               ├─ 3. fill model → execution price
                               ├─ 4. position + P&L mutation
                               ├─ 5. OCO sibling cancel / bracket spawn
                               ├─ 6. risk post-checks (DD, DLL, pass/fail)
                               ├─ 7. single DB transaction (orders, executions,
                               │     positions, trades, account, audit, seq++)
                               └─ 8. publish sequenced deltas to WS subscribers
```

Order lifecycle: `CREATED → VALIDATING → WORKING → PARTIALLY_FILLED → FILLED`, with
`CANCEL_PENDING → CANCELED` and `REJECTED` terminals. Every transition is audited.

Fill models (configurable per account):
- **Simple** — marketable side of the book; limits fill on touch/cross.
- **Advanced** — configurable latency and slippage in ticks, with limit orders requiring a
  through-trade rather than a touch.
- **Depth-aware** — interface reserved; requires a Level 2 feed (`LICENSED / EXTERNAL`).

Market orders never use candle close. They use the quote store's bid/ask, or last trade when
the book is one-sided, always through the configured fill model.

---

## 9. Risk-engine architecture

Every order request passes the pipeline before the engine sees it:

```
authenticate → resolve account → account status gate → instrument gate →
market-availability gate → staleness gate → tick-size / price sanity →
quantity & contract-limit gate → duplicate/idempotency gate →
daily-loss-limit gate → max-loss / drawdown gate → ACCEPT
```

Rejections return a machine-readable `reason_code` (`ACCOUNT_FAILED`, `MAX_CONTRACTS`,
`DAILY_LOSS_LIMIT`, `INVALID_TICK`, `MARKET_DATA_STALE`, `DUPLICATE_ORDER`, …) and write a
`risk_events` row.

Drawdown is three distinct, non-interchangeable engines selected by the rule template:
**Static** (fixed floor from starting balance), **Intraday trailing** (trails peak *equity*,
including open P&L), **End-of-day trailing** (trails peak *settled balance* at session close).
The consistency engine computes `bestDay / totalNetProfit` with a configurable threshold and
formula. All three are pure functions, deterministic, and are the most heavily tested code in
the repository.

---

## 10. APIs and WebSocket channels

REST (`/api/v1`): `auth/register|login|refresh|logout|me`, `instruments`,
`marketdata/bars|quote|status`, `accounts` (+`/flatten`, `/stats`), `rule-templates`,
`orders` (POST submit / PATCH modify / DELETE cancel / `cancel-all`), `positions`
(+`/close`, `/reverse`), `trades`, `layouts`, `layouts/:id/drawings`,
`layouts/:id/indicators`, `diagnostics/latency`.

WebSocket (`/ws`) — one multiplexed socket, channel subscriptions, every frame carries a
monotonic `seq`:

| Channel | Payload |
| --- | --- |
| `md.quote.{symbol}` | top-of-book + last, exchange ts |
| `md.trade.{symbol}` | prints |
| `md.bar.{symbol}.{tf}` | forming + closed bars |
| `md.depth.{symbol}` | L2 when a licensed feed is attached |
| `md.status` | DELAYED / REALTIME / DISCONNECTED / RECONNECTING / STALE |
| `acct.{id}.orders` | order lifecycle deltas |
| `acct.{id}.executions` | fills |
| `acct.{id}.positions` | position deltas |
| `acct.{id}.pnl` | equity, UP&L, RP&L, drawdown |
| `acct.{id}.risk` | rule state, breaches |
| `acct.{id}.status` | ACTIVE/PASSED/FAILED/… |
| `sys.heartbeat` | server clock + latency probe |

Recovery: client sends `resume{lastSeq}`; server replays if within the buffer, otherwise
sends `snapshot` and resets the sequence. Snapshots are authoritative and replace local state.

---

## 11. Dependencies

`OSS DEPENDENCY`: fastify, ws, drizzle-orm, postgres, ioredis, zod, argon2, jsonwebtoken,
luxon, react, react-dom, vite, zustand, lightweight-charts, vitest, typescript, tsx.

## 12. External services

| Service | Status |
| --- | --- |
| PostgreSQL 16, Redis 7 | available locally, running |
| Delayed exchange OHLCV feed | reachable, real data, no credential |
| Databento / CME MDP / Rithmic / dxFeed real-time | `LICENSED / EXTERNAL` — no credential |
| CME Level 2 depth | `LICENSED / EXTERNAL` — DOM shows top-of-book until attached |
| TradingView Advanced Charts | `LICENSED / EXTERNAL` — adapter stub only |

## 13. Buildable immediately

Everything in Milestones 1–10 except real-time L1/L2 and Advanced Charts: the instrument
registry, auth, database, the delayed real-data provider, replay mode, candle aggregation,
the chart with drawings and indicators, the full simulation engine, chart trading, the DOM
(top-of-book), the prop risk/drawdown/consistency engines, multi-chart layouts, and the tests.

## 14. Requires credentials or licensing

Real-time CME data, Level 2 depth, TradingView Advanced Charts, and any real-money or payout
functionality. These are interfaces and stubs in this repository, never claimed as working.

## 15. Milestone plan

M1 architecture/DB/instruments/auth/shell · M2 real data + aggregation · M3 chart ·
M4 drawings/indicators/layouts · M5 execution engine · M6 order panel + chart trading ·
M7 DOM · M8 prop risk engines · M9 multi-chart + all 8 products · M10 hardening.
Each milestone ends with tests run, a status report, and an explicit list of what remains
mocked.
