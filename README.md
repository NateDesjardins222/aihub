# Atlas Futures Terminal

A simulation futures trading platform. Real exchange-derived market data, a server-side
simulation execution engine, and prop-firm evaluation rules.

**Everything is simulated.** No order is routed to any exchange or broker, and no real funds
are involved. Market data is genuine but **delayed by roughly ten minutes** and is never
presented as real-time.

---

## Quick start

You need **Node 22+**, **pnpm**, and **PostgreSQL 14+**.

```bash
git clone https://github.com/NateDesjardins222/aihub
cd aihub
git checkout claude/futures-trading-simulator-v8qefu

./scripts/setup.sh     # creates the database, migrates, seeds
pnpm dev               # starts the API and the web terminal
```

Open **http://localhost:5173**

```
email     demo@atlasfutures.local
password  atlas-demo-2026
```

No PostgreSQL installed? `docker compose up -d db` first, then run the setup script.

`scripts/setup.sh` is safe to re-run. It will not overwrite an existing `.env`.

---

## What works today

Milestones 1 and 2 are complete. See `docs/milestones/` for the full reports, including
known bugs and what is deliberately not built yet.

**Try this in order:**

1. **Sign in.** Pick an account in the header — three prop products are seeded, with three
   different drawdown types. Balance, drawdown and profit target are read from the database.
2. **Watch NQ.** It loads by default with real front-month candles. The legend shows OHLCV,
   the bar's exchange timestamp, and a countdown to the bar close. The price updates as
   delayed market data arrives.
3. **Check the feed badge** (top right, and on the chart toolbar). It reads `DELAYED 10m`
   with the measured latency. Hover it — the tooltip states the exact delay in seconds.
   There is no code path in this platform that can label this feed real-time.
4. **Switch timeframes** — 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1D. All are folded from the same
   real series, and intraday buckets are anchored to the 17:00 CT session open, so a 4h bar
   runs 17:00–21:00 rather than being cut by UTC midnight.
5. **Scroll left.** The chart pages backwards through genuinely older market data. Keep
   going and it will tell you when you have reached the limit of what this feed serves.
6. **Switch instruments.** NQ, MNQ, ES, MES, GC, MGC, CL, MCL. Watch the contract code,
   exchange and tick size change with them — CL shows NYMEX and a 0.01 tick, GC shows COMEX,
   NQ shows CME and 0.25. Nothing is hardcoded per symbol.
7. **Open the DOM tab.** It says `MARKET DEPTH UNAVAILABLE` and draws no ladder rows,
   because this feed has no order book. Inventing them would be fabricating market data.
8. **Open the Replay tab.** Capture a real past session (pick a date within the last seven
   days), load it, and play it back at 1× to 50×. The prices are the market's own; speed
   changes how fast the clock runs, never what the prices are.
9. **Refresh the browser.** Your session, account, symbol, timeframe, chart type and panel
   sizes all come back.
10. **Drag the panel edges.** They resize, collapse and remember their dimensions.

**Not built yet, and labelled as such in the UI:** order entry, positions, P&L, the drawing
tools, indicators, and the live risk engine. Those regions name the milestone that delivers
them rather than showing controls that do nothing.

---

## Commands

```bash
pnpm dev          # API on :4000, web terminal on :5173
pnpm test         # 118 tests
pnpm typecheck    # all packages, strict
pnpm db:migrate   # apply migrations
pnpm db:seed      # re-seed prop products and the demo trader
```

## Layout

```
packages/contracts     shared types and Zod schemas
packages/instruments   instrument registry, tick maths, session and roll calendars
packages/core          pure engines: bucketing, folding, candle aggregation
apps/server            Fastify API, WebSocket gateway, market data pipeline
apps/web               React terminal
docs/                  architecture, IP compliance, milestone reports
```

## Market data

Phase 1 uses a public endpoint serving real CME/COMEX/NYMEX front-month OHLCV, delayed about
ten minutes. It provides no bid, no ask and no depth, and the platform says so rather than
filling the gaps.

It is **development only** — the terms do not permit redistribution and the delay makes it
unusable for live execution. It sits behind `MarketDataProvider`, which is the only
vendor-aware interface in the system, so attaching a licensed feed (Databento, CME MDP,
Rithmic, dxFeed) is a sibling of one file plus credentials, with no changes to trading,
charting, aggregation or risk code.

## Licensing and IP

No TradingView or Topstep source code, assets, logos or branding is reproduced. The Phase 1
chart renderer is `lightweight-charts`, published by TradingView under Apache-2.0 — a
dependency, correctly attributed, not copied code. TradingView Advanced Charts is a
commercial product this project does not license; the adapter for it is an explicit stub that
throws, and is never offered. See `docs/IP-COMPLIANCE.md`.
