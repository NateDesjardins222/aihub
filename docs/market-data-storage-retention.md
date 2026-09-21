# Market-data storage and retention

What Atlas persists from the market-data path, why, and for how long. The
principle: **do not persist every professional tick forever.** Atlas stores
what it needs to bootstrap a chart, resolve a contract, mark a position, and
recover a feed — not a raw firehose. (Professional Market Data V2, Phase 80.)

| What | Where | Written when | Retention | Why |
| --- | --- | --- | --- | --- |
| **Closed bars** (per symbol/timeframe, integer ticks) | `historical_bars` (`bar-service.ts`) | a bar closes / on history fetch | operational cache — refetchable from the provider, safe to prune | chart bootstrap + candle audit; never re-downloaded if cached |
| **Contract metadata / identity** | `orders.contract_code`, `executions.contract_code`, `trades.contract_code`, `positions.contract_code` | at order / fill / trade / position open | permanent (financial record) | a fill belongs to a specific contract forever; the open-position lock reads it |
| **Operational market-data state** | `market_data_meta` (provider, mode, delay, last event, depth levels — per symbol) | on each observation (upsert) | latest only (one row per symbol) | System Health, freshness, provider identity — not a history |
| **Recorded sessions** (replay provider) | JSONL under `REPLAY_DIR` | only when a recording is started | operator-controlled; **replay-to-user rights are unconfirmed** (`market-data-licensing.md` §5.7) | the replay provider; NOT served to end users |
| **Forming bars, quotes, top-of-book, the tape** | in-memory only (aggregator, quote store) | live | not persisted | derived/live; rebuilt from history + the live stream on restart |

## Not stored

- **Raw ticks / trade prints** are not persisted as a durable tape. They flow
  through the aggregator into bars (which are cached) and the quote store (live
  only). A professional realtime tape, if ever needed, is a deliberate future
  decision with its own retention and licensing analysis — not a default.
- **Per-quote / per-trade history** — the bus and latency recorder keep bounded
  in-memory counters and windows, never an unbounded log (see the memory notes
  in the V2 report).

## Licensing constraint on storage

Storing exchange data and replaying it are **separate rights** from displaying
it live (`market-data-licensing-gate.md`). Recorded sessions are for internal
development and are not cleared to be replayed to end users until the licensing
question is answered. The bar cache holds derived OHLCV, which most datasets
permit to redistribute after 24h — but Atlas ships `MARKET_DATA_REDISTRIBUTION=
none` and makes no such claim until an entitlement exists.

## Growth bounds

- Bar cache: bounded by symbols × timeframes × window; prunable, refetchable.
- `market_data_meta`: one row per symbol.
- In-memory aggregator: `maxFineBars` cap (default 40,000) per symbol.
- Quote store: last quote + a bounded trade buffer per symbol.
None grows unbounded with feed volume.
