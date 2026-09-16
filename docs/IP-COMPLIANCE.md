# Intellectual property compliance

This platform reproduces *functionality, workflows and interaction concepts*. It does not
reproduce anyone else's source code, visual assets, logos, trademarks or branding.

## What we did not do

- No TradingView or Topstep source code was copied, decompiled, transcribed or adapted.
- No proprietary visual assets, icon sets, colour schemes, typefaces or layouts were copied.
- No trademarks or product names are used as our own. "Atlas Futures Terminal" is original.
- No Pine Script implementation, grammar or runtime is reproduced. Our indicator system is
  an original plug-in architecture with a TypeScript interface.

## What we did do

- Read the **publicly documented capabilities** of professional charting and futures
  execution products and designed toward comparable feature coverage with original code.
- Built our own drawing framework, indicator framework, chart adapter, DOM, order panel,
  simulation engine and risk engines.
- Used `lightweight-charts` as the Phase 1 rendering engine. It is published by TradingView
  under the **Apache License 2.0** — an open-source licence that permits commercial use.
  It is a dependency, correctly attributed, not copied code.

## TradingView Advanced Charts

TradingView Advanced Charts / Charting Library is a **commercial product requiring a signed
licence agreement and a library bundle distributed by TradingView**. We do not possess either.

Our approach:

- `ChartAdapter` is an interface. `LightweightChartsAdapter` implements it today.
- `TradingViewAdvancedChartsAdapter` is a **stub** implementing the same interface, alongside
  the `Datafeed` and `Broker` integration shapes their documented API expects. It is inert
  and throws a clear "requires a licensed bundle" error if constructed without one.
- A licensee can drop in their bundle and switch adapters without touching trading code.

At no point does this repository claim that Advanced Charts functionality is implemented.

## Market data

Phase 1 uses genuine exchange-derived delayed OHLCV. It is labelled `DELAYED` in the UI with
the delay stated, and is never presented as real-time.

Real-time CME data, Level 2 market depth, and any redistribution of exchange data require
licence agreements with CME Group or an authorised vendor. These are `LICENSED / EXTERNAL`
in this repository: interfaces exist, implementations do not, and nothing claims otherwise.

## Simulation only

Every order, fill, position, balance and payout figure in this platform is simulated. Nothing
is routed to any exchange or broker, and no real funds are involved. The UI carries a `SIM`
badge in the header at all times.
