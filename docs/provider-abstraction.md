# Provider abstraction

Two separate concerns, two separate seams.

## Market data (already existed; documented here)

`apps/server/src/marketdata/provider.ts` defines `MarketDataProvider` and the
richer `DescribableProvider` with a real `ProviderCapabilities` contract:

```
providesTrades / providesQuotes / providesTopOfBook / providesDepth /
providesOhlcv, history[]  (per-timeframe lookback + range-query support)
```

Events are a normalized union, `ProviderEvent = quote | trade | bar | depth |
status`, each carrying an `observedAt`. Providers are chosen by env
(`MARKET_DATA_PROVIDER`) and can be swapped at runtime (`switchProvider`). Two
implementations exist: `YahooDelayedProvider` (delayed OHLCV, no book) and
`ReplayProvider`.

Capability discovery is the rule: callers ask `capabilities()` rather than
assume trades, quotes, depth, or historical exist. Depth is `null` when there is
no book; a delayed feed declares its delay and never claims real-time.

This means a professional adapter (Rithmic/CQG/Databento) is a new
implementation of an existing interface, not a rewrite. **None is implemented in
this milestone**, by instruction.

## Execution (new this milestone)

`apps/server/src/execution/provider.ts` defines `ExecutionProvider` — a
capability-based, account-scoped contract (submit/cancel/cancelAll/modify/
flatten/reverse/getAccountState, plus `capabilities()` and `status()`). Market
data and execution are different concerns and now have different seams.

`AtlasSimulationExecutionProvider` wraps the trading engine one-for-one. It adds
no behaviour; it proves the engine's operations map cleanly onto the neutral
contract, so a future `RithmicExecutionProvider` has a definite shape to meet.
It inherits the engine's cross-process account lock unchanged.

`ExecutionCapabilities` lets a future live provider decline features the
simulator has (bracket attachment, synthetic reverse) without breaking callers.

### Simulation stays first-class

Professional market data feeding `AtlasSimulationExecutionProvider` is an
explicitly supported architecture: an evaluation account is simulated even when
the prices are real. The two seams are independent — choosing a live data
provider does not couple Atlas to live execution.

## Honest limits

- The execution seam is defined and satisfied by the simulator and unit-tested,
  but the app's routes and WebSocket gateway still hold the concrete
  `TradingEngine`, not the `ExecutionProvider` interface. Routing every call site
  through the interface (dependency injection) is the remaining, mechanical step
  and is **deferred** — the seam exists and fits; the wiring does not yet make it
  the sole path.
- No live provider adapter (market data or execution) is implemented or faked.
