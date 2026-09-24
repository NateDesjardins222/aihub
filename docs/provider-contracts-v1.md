# Provider Contracts V1 — the two seams Atlas connects the world through

**Milestone 4.** This document is the contract reference for the two — and only
two — provider seams in Atlas: **market data** and **execution**. They are
separate by construction. There is no "BrokerProvider". A vendor may sit behind
one, the other, or both, and downstream code never learns which.

> Atlas owns the domain; providers are adapters. Every provider-specific object
> terminates at an adapter boundary. Above it, the platform speaks only
> Atlas-owned normalized contracts.

Contracts live in `packages/contracts/src/infrastructure.ts` (provider-neutral
infrastructure types) and `apps/server/src/marketdata/` /
`apps/server/src/execution/` (the running seams).

---

## 1. Shared vocabulary

| Type | Values | Meaning |
| --- | --- | --- |
| `ProviderConfigState` | `UNCONFIGURED` \| `CONFIGURED` | Whether a provider has the server-side config it needs. **UNCONFIGURED is boot-safe and first-class** — a provider without credentials reports it and never fails the process, never fakes `CONNECTED`. |
| `ProviderHealthState` | `UNCONFIGURED` \| `CONNECTING` \| `CONNECTED` \| `DEGRADED` \| `DISCONNECTED` \| `ERROR` | Coarse operational health, shared by both seams. |
| `MarketDataProviderKind` | `yahoo-delayed` \| `replay` \| `databento` \| `rithmic` \| `scripted` | Which market-data adapter. |
| `ExecutionProviderKind` | `simulation` \| `rithmic` \| `scripted` | Which execution adapter. |
| `ProviderHealthSnapshot` | (struct) | The **redacted** health record surfaced to owners. Never carries a credential. |

`ProviderHealthSnapshot` fields: `providerId`, `role` (`MARKET_DATA` |
`EXECUTION`), `kind`, `configState`, `health`, `isSimulation`, `detail`,
`lastConnectAt`, `lastDisconnectAt`, `lastMessageAt`, `lastHeartbeatAt`,
`reconnectCount`, `subscriptionCount`, `lastError`. Every string in it is safe
to show an operator; assembling it is the provider's own job (`healthSnapshot()`).

---

## 2. The market-data seam

Interface: `MarketDataProvider` (`apps/server/src/marketdata/provider.ts`).

- **Read-only.** A market-data provider emits normalized events; it never
  executes.
- `readonly id: string`, `readonly mode: 'DELAYED' | 'REALTIME' | 'REPLAY'`.
- Events are `NormalizedQuote | NormalizedTrade | NormalizedBar |
  NormalizedDepth | ConnectionStatus`, each stamped with an observation time.
- `getConnectionStatus(): ConnectionStatus` — `providerId`, `state`, `mode`,
  `delaySeconds`, `declaredDelaySeconds`, `lastEventAt`, `lastMessageAt`,
  `reconnectAttempts`, optional `error`.
- Capabilities are **asked, never assumed**: a caller that needs depth asks; a
  provider that lacks it returns a structured `CapabilityError`
  (`kind: 'CAPABILITY_UNAVAILABLE'`). **There is no silent fallback** from a
  professional realtime feed to the development feed.

Contract invariants:

1. **Never label delayed data realtime.** `mode` is the truth; the terminal's
   data-mode badge is driven by it (M4-Y), never hardcoded.
2. **Never fabricate.** A provider with no data emits nothing / `NO_DATA`
   freshness. It never invents a print.
3. **Staleness is judged against the *declared* delay**, so a frozen feed
   measuring an ever-growing delay is caught rather than calibrated to.

Adapters present: `yahoo` (delayed, default), `replay` (recorded playback),
`databento` (realtime option, historical HTTP + live DBN seam), `rithmic`
(UNCONFIGURED scaffold), `scripted` (test double, never networked).

Selection is `MARKET_DATA_PROVIDER` — **server-side, deliberate, fail-fast**.
The browser can never choose it.

---

## 3. The execution seam(s)

Execution has **two shapes** by design, so the simulation engine and an async
external venue can both be first-class without a second P&L engine.

### 3a. Engine-shaped: `ExecutionProvider`

`apps/server/src/execution/provider.ts`. The synchronous, engine-shaped seam the
Atlas simulator implements (`AtlasSimulationExecutionProvider`, the only
implementation). It is what copy trading and the trading routes call. Fills are
authoritative and immediate because the Atlas engine *is* the venue.

- `id`, `capabilities(): ExecutionCapabilities`, `status():
  ExecutionProviderStatus`.
- This seam is **unchanged** by Milestone 4 — copy trading and simulation are
  untouched.

### 3b. Async external: `ExternalExecutionAdapter`

`apps/server/src/execution/external-provider.ts`. The seam a real venue
(Rithmic) sits behind. It is fundamentally different from 3a: **an ack is not a
fill.**

- `configState()`, `capabilities()`, `health()`, `healthSnapshot()`.
- `connect()` / `disconnect()`.
- `submit(input): Promise<ExternalAck>` — returns transport acceptance only.
  `accepted: true` with `state: 'SUBMITTED'` means the venue took the order, not
  that it filled. Idempotent on `clientOrderId`.
- `cancel()`, `modify()`.
- `listWorkingOrders()`, `listPositions()` — the venue's authoritative snapshot,
  for reconciliation.
- `onReport(listener)` — async execution reports (`ExecutionReport`): partial and
  full fills, rejects, cancels, arriving after the ack.
- Errors are structured `ExternalExecutionError` with codes
  `PROVIDER_UNCONFIGURED` \| `PROVIDER_DISCONNECTED` \| `NOT_SUPPORTED` \|
  `REJECTED` \| `TIMEOUT` \| `UNKNOWN` and a `retryable` flag. **A credential
  never appears in an error message.**

Contract invariants:

1. **Ack ≠ fill.** Atlas advances an order's state only on an execution report,
   never on transport success (`applyExecutionReport`).
2. **A lost acknowledgement is `UNKNOWN`**, never assumed filled or canceled
   (`markUnknown`). The truth is recovered by reconciliation.
3. **Idempotent submit.** A retried command with the same client order id reuses
   the existing order (`recordExternalOrder` on the unique idempotency key), and
   the adapter returns the same provider order id.
4. **Duplicate reports are suppressed** by a dedupe key; fills are **monotonic**
   (a stale report can never reduce filled quantity).

Adapters present: `rithmic-execution` (UNCONFIGURED scaffold; `connect()` throws
`PROVIDER_UNCONFIGURED`, or `NOT_SUPPORTED` when configured — it never fakes a
connection), `scripted-execution` (deterministic test double).

---

## 4. Routing: who serves an account

`ExecutionRegistry` (`apps/server/src/execution/registry.ts`) is the single place
that decides which provider serves an account, **by execution mode, server-side**.

- `ExecutionMode` = `SIMULATION` | `EXTERNAL_PAPER` | `EXTERNAL_LIVE`.
- Default (and only reachable mode this milestone) is `SIMULATION` → the Atlas
  engine.
- `externalReadiness(mode, kind)` returns ready/why-not. External is ready only
  when the adapter is **registered AND configured AND connected**, and — for
  `EXTERNAL_LIVE` — the `EXTERNAL_LIVE_ENABLED` master gate is true.
- The browser can never express a provider or a mode. It expresses *intent*; the
  registry and the account↔provider mapping decide the rest.

Copy trading is unaffected: it addresses accounts by Atlas id and asks the
registry per account. The provider behind an account can change in future
without a separate copy-trading execution path.

---

## 5. Adding a provider later

1. Implement `MarketDataProvider` **or** `ExternalExecutionAdapter` (or both, as
   separate classes — never one object).
2. Terminate every vendor object at that boundary; emit only normalized
   contracts.
3. Report `UNCONFIGURED` until server-side config is present; never fake
   `CONNECTED`; never log/emit/return a credential.
4. Register it (market data via `MARKET_DATA_PROVIDER`; execution in the
   registry's external map).
5. Nothing in the terminal, risk engine, account system, or copy trading
   changes. That is the whole point.
