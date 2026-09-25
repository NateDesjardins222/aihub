# Rithmic Market Data (Milestone 9)

TICKER plant → normalized Atlas events. Only real provider observations become
canonical events; nothing is fabricated.

## Subscription
`RequestMarketDataUpdate` (SUBSCRIBE) with an update-bits mask OR-ed from the
schema enum: LAST_TRADE, BBO, OPEN, HIGH_LOW, CLOSE, MARKET_MODE, SETTLEMENT.
Order-book bits are decode-capable but no full DOM is built in M9.

## Normalization (`domain/market-normalize.ts`)
- LastTrade → NormalizedTrade (price, size, aggressor, exchange ts from ssboe/usecs).
- BestBidOffer → NormalizedQuote (`synthesizedBook: false` — a real book).
- A message with no usable price yields **no** event.
- Prices are provider doubles; timestamps are exchange time (ssboe·1000 + usecs/1000).

## Freshness (`domain/freshness.ts`)
Per symbol: last provider ts, last receive ts, observed age, messages/sec, stale
flag. Truthful labels — **CONNECTED / STALE / RECONNECTING / DISCONNECTED**: a
connected socket with no recent data is STALE, not CONNECTED. If the Test feed is
delayed/entitlement-limited or the market is closed, that shows.

## RAW vs SMOOTH
RAW = actual observations (fills, candles, stops, targets, risk, P&L, recorded
history). SMOOTH is presentation interpolation only and never affects any of those.

## Performance
The visible price updates immediately from the normalized event stream; persistence
and real-time distribution are separate. Ticks are not routed through PostgreSQL
before rendering, and individual updates are not needlessly batched.
