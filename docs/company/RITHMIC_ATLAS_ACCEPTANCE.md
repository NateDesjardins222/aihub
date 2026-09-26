# RITHMIC + ATLAS — TEST MARKET-DATA / TERMINAL ACCEPTANCE

**Phase 6 — Atlas + Rithmic Test market-data & execution-path acceptance + correctness.**

Baseline HEAD at acceptance: `b2936c8` (Phase 5 checkpoint) · Compiled 2026-09-26 ·
branch `claude/futures-trading-simulator-v8qefu`.

> **The Phase 6 rule, stated once:** *A backend that exists is not a product that works.*
> Everything provable **without live Rithmic credentials** is proven here, deterministically and
> repeatably, and classified **PROVEN**. Everything that requires a real authenticated session
> against **Rithmic Test** (R\|Protocol wire conformance, live auth, a live tick, a live order
> round-trip) **cannot run in this container** (no credentials, by policy) and is classified
> **OWNER MANUAL REQUIRED** — never faked, never called production-ready. This document is the
> checklist the owner runs to close the live half.

---

## 0. Honest verdict

The Rithmic stack is a **fully-built, honestly-gated integration**, not a stub and not a fake.
Every wire concern — framing, codec, template registry, plants, connection state machine,
heartbeat, reconnect, discovery, market-data normalization, freshness, historical bars,
order lifecycle, P&L, reconciliation, metrics — is implemented and covered by deterministic
tests that run against an in-memory mock transport and a committed test-double proto schema.
It is reachable **only** when `RITHMIC_*` env is set; otherwise every seam reports `UNCONFIGURED`
and **refuses to fabricate `CONNECTED`, a quote, a bar, or a fill.** Provider selection is
deliberate and fail-fast — there is **no fallback masking** (choosing `rithmic` without config
throws; it never silently serves another feed while wearing the Rithmic label).

The one thing not provable in code is **real R\|Protocol conformance and live auth against
Rithmic Test**. The code labels that state truthfully everywhere an owner can read it:
`configured … NOT_VERIFIED`, `verified: false`, `live acceptance not confirmed in this
environment`. That is the Phase 6 live-acceptance gate below — the honest boundary, by design.

Nothing here is PRODUCTION-VERIFIED. Rithmic remains **TEST-only** and is **not** wired to any
production Rithmic system.

---

## 1. Environment reality in this container (why the live half is OWNER MANUAL)

- **No Rithmic credentials are present.** `RITHMIC_ENABLED` defaults `false`; `RITHMIC_USER`,
  `RITHMIC_PASSWORD`, `RITHMIC_ENDPOINT`, `RITHMIC_SYSTEM_NAME`, and the M4 credential set are all
  unset/`.optional()`. `resolveRithmicConnection()` returns `{ ok: false, missing: [...] }`.
- **The official RProtocolAPI package is not vendored.** The protocol registry uses the committed
  **test-double** proto unless `vendor/rithmic/proto` (or `RITHMIC_VENDOR_DIR`) is populated and
  `pnpm rithmic:generate` is run. So framing/codec/enum bijection is proven against a faithful
  double, **not** the official schema — official wire conformance is a live-acceptance item.
- **Credential-safety policy respected:** no `.env` is tracked (only `apps/server/.env.example`
  placeholders), no Rithmic credentials were created, and no live host was contacted.

Therefore: **deterministic correctness → PROVEN here. Live Rithmic Test session → OWNER MANUAL
REQUIRED** (see §9). This is not a gap to paper over; it is the correct division of labor.

---

## 2. Component matrix — transport / protocol / connection

Legend: **PROVEN** (deterministic test, no creds) · **OWNER-MANUAL** (needs live Rithmic Test).

| Component | File | Status | Evidence |
|---|---|---|---|
| WS transport (binary frames, TLS, connect timeout, error sanitize) | `rithmic/transport/ws-transport.ts` | PROVEN (seam) | `sanitizeTransportError` strips creds — `torture.test.ts` |
| Transport seam + deterministic `MockRithmicTransport` | `rithmic/transport/transport.ts` | PROVEN | drives every connection test |
| Wire framing (4-byte BE length prefix, 8 MB max, `FrameStream` reassembly) | `rithmic/protocol/framing.ts` | PROVEN | `protocol.test.ts`, `torture.test.ts` (coalesced/zero-length/oversize) |
| Codec (encode/decode, schema-independent `template_id` scan, structured errors) | `rithmic/protocol/codec.ts` | PROVEN | `protocol.test.ts`, `torture.test.ts` (truncated body / unknown enum → structured error) |
| Template/schema registry (official pkg → else committed test-double; ids **derived, never hardcoded**) | `rithmic/protocol/registry.ts` | PROVEN (double) / **OWNER-MANUAL** (official pkg) | `protocol.test.ts` "does not hardcode ids" |
| Message router (by-name + `user_msg` correlation + unknown sink; handler isolation) | `rithmic/protocol/router.ts` | PROVEN | `torture.test.ts` |
| Plant (single connection: connect → login → heartbeat → reconnect) | `rithmic/plants/plant.ts` | PROVEN | `connection.test.ts` |
| **Connection state machine** | `rithmic/plants/plant.ts` | PROVEN | see §3 |
| RequestLogin (SysInfraType per plant from schema; `rp_code` mapping; hard-vs-transient) | `rithmic/plants/plant.ts` | PROVEN | `connection.test.ts` (rp_code 0 → AUTHENTICATED) |
| Hard auth failures terminal, **no reconnect** (`AUTH_FAILED`/`PERMISSION_DENIED`/`AGREEMENT_REQUIRED` → FAILED) | `rithmic/plants/plant.ts` | PROVEN | `connection.test.ts` |
| Heartbeat (server-dictated interval, watchdog liveness, answers server heartbeat) | `rithmic/plants/plant.ts` | PROVEN | `connection.test.ts` (DEGRADED on silence) |
| Reconnect (bounded backoff + jitter, no storm) | `rithmic/plants/plant.ts`, `connection-lifecycle.ts` | PROVEN | `connection.test.ts`, `torture.test.ts` (caps at maxMs) |
| Discovery (`RequestRithmicSystemInfo` + verify configured system present) | `rithmic/plants/discovery.ts` | PROVEN | `connection.test.ts` (`SYSTEM_ABSENT` when "Rithmic Test" missing — never silent swap) |
| Connection manager (multi-plant, discovery-first, redacted health, host-only endpoint) | `rithmic/plants/connection-manager.ts` | PROVEN | `connection.test.ts` (`allHealthy()` requires every plant AUTHENTICATED + live) |
| Metrics (bounded-cardinality counters) | `rithmic/metrics.ts` | PROVEN | `metrics.test.ts` (no unbounded keys) |
| Config resolver (`ok/reason/missing[]`, names only never values) | `infra/rithmic-config.ts` | PROVEN | `providers.test.ts` |
| **Live R\|Protocol conformance + auth vs Rithmic Test** | (network) | **OWNER-MANUAL** | §9 |

---

## 3. Connection state machine (vocabulary, PROVEN)

`PlantState` (`rithmic/plants/plant.ts`):

```
DISCONNECTED → CONNECTING → CONNECTED → AUTHENTICATING → AUTHENTICATED
                                 │
            watchdog stale ──────┴──▶ DEGRADED → RECONNECTING ──▶ (CONNECTING…)
            hard auth reject ─────────▶ FAILED (terminal, no reconnect)
            stop() ──────────────────▶ STOPPED
```

`PlantKind`: `DISCOVERY · TICKER · ORDER · HISTORY · PNL · REPOSITORY`.
Login error codes: `AUTH_FAILED · SYSTEM_UNAVAILABLE · AGREEMENT_REQUIRED · PERMISSION_DENIED ·
TIMEOUT · TRANSPORT_ERROR · PROTOCOL_ERROR · UNKNOWN`. `allHealthy()` = every configured plant
AUTHENTICATED **and** not watchdog-stale. An open socket is **not** treated as "healthy."

---

## 4. Component matrix — market data (PROVEN deterministically)

| Component | File | Status | Evidence |
|---|---|---|---|
| Subscription (`RequestMarketDataUpdate`, UpdateBits mask from schema, idempotent, restore-on-reconnect) | `rithmic/plants/market-data-service.ts` | PROVEN | `market-data.test.ts` |
| Normalize `LastTrade`→trade / `BestBidOffer`→quote (never fabricated) | `rithmic/domain/market-normalize.ts` | PROVEN | `market-data.test.ts` (null-on-no-price) |
| Timestamp conversion `rithmicTsToMs` (ssboe·1000 + usecs/1000 = **ms**; ssboe ≤ 0 rejected) | `rithmic/domain/market-normalize.ts` | PROVEN | `market-data.test.ts`, `torture.test.ts` |
| Freshness tracker (open socket ≠ fresh; `CONNECTED/STALE/RECONNECTING/DISCONNECTED`) | `rithmic/domain/freshness.ts` | PROVEN | `market-data.test.ts`, `torture.test.ts` |
| Historical bars (`RequestTimeBarReplay`, timeframe→bar map, dedup by open time, drop bad OHLC) | `rithmic/plants/market-data-service.ts` | PROVEN | `market-data.test.ts` (every M9 timeframe) |
| Bar compare + historical/live merge (field-exact diff; no dup/backward/phantom/double-vol) | `rithmic/domain/bar-compare.ts` | PROVEN | `market-data.test.ts`, `torture.test.ts` |
| Rithmic `MarketDataProvider` seam (`getQuote` never fabricates; truthful `getConnectionStatus`) | `marketdata/providers/rithmic.ts` | PROVEN | `providers.test.ts` |
| **Live tick / live bar / feed against Rithmic Test** | (network) | **OWNER-MANUAL** | §9 |

**Quote→normalized→bar chain (traced):** TICKER plant `onMessage` → `codec.decode` → router →
`RithmicMarketDataService.onLastTrade/onBBO` → normalize → `MarketEvent{trade|quote}` →
`RithmicMarketDataProvider.onServiceEvent` → `MarketDataService` subscription → `BarService`.
**Behavioral note (intended, confirm on live feed):** Rithmic BBO quotes carry `last: null`, so
**bars are trade-driven only** — quotes do not advance the forming candle. On a Test feed with
sparse trades, candles will look sparse even while BBO updates flow. This is correct for a
trade-driven candle model; verify it matches expectations during the live pass.

---

## 5. Component matrix — order / execution (PROVEN deterministically)

| Component | File | Status | Evidence |
|---|---|---|---|
| Execution registry (server-side mode routing; SIMULATION always; EXTERNAL gated) | `execution/registry.ts` | PROVEN | `providers.test.ts` (`externalReadiness` = registered + CONFIGURED + CONNECTED + `EXTERNAL_LIVE_ENABLED`) |
| Safety gate (mapping / contract / session / freshness / provider) | `execution/safety-gate.ts` | PROVEN | tested "so it is safe the day it is enabled" |
| External adapter seam (async ack ≠ fill; UNKNOWN representable) | `execution/external-provider.ts` | PROVEN | `providers.test.ts` |
| **Rithmic execution adapter** (connect refuses if `!executionEnabled`; structured secret-free error) | `execution/providers/rithmic-execution.ts` | PROVEN (refusal) / **OWNER-MANUAL** (live route) | `execution.test.ts`, `providers.test.ts` |
| Order service (account/route discovery, submit/modify/cancel, dedup, lost-ack) | `rithmic/plants/order-service.ts` | PROVEN | `execution.test.ts` (lost ack → `SUBMISSION_UNKNOWN`, never blind resubmit) |
| Order normalize (schema enums, `quantity_64`, exec dedup key, ack ≠ fill) | `rithmic/domain/order-normalize.ts` | PROVEN | `execution.test.ts` |
| P&L service (positions + account P&L; Rithmic view never overwrites Atlas ledger) | `rithmic/plants/pnl-service.ts` | PROVEN | via execution adapter tests |
| Reconciliation (order + position verdicts; provider-only never invented) | `rithmic/domain/reconcile.ts` | PROVEN | `reconcile.test.ts` (MATCHED / REQUIRES_REVIEW / UNKNOWN) |
| **Live order round-trip vs Rithmic Test (submit → ack → fill → position → P&L)** | (network) | **OWNER-MANUAL** | §9 |

Default posture: `EXECUTION_PROVIDER=simulation`, `EXTERNAL_LIVE_ENABLED=false`. Rithmic execution
is **reachable** when `EXECUTION_PROVIDER=rithmic` + `RITHMIC_EXECUTION_ENABLED` + registered;
otherwise the seam reports `UNCONFIGURED` and every op throws a structured, secret-free error.

---

## 6. Instrument matrix (PROVEN)

Eight launch roots, authoritative in `packages/instruments/src/registry.ts`; Rithmic economics
derived from it (never guessed) in `rithmic/domain/instruments.ts` (`atlasCanonical`,
`rithmicExchange`). Micros are **exactly 1/10** of their full-size sibling — proven by
`registry.test.ts` and economically by `trading/money-oracle.test.ts` (MNQ P&L is exactly 1/10 of
NQ; mini economics are never applied to a micro).

| Root | Exchange | Tick | Point value | Tick value | Mult | Micro of |
|---|---|---|---|---|---|---|
| NQ | CME | 0.25 | $20 | $5.00 | 20 | — |
| MNQ | CME | 0.25 | $2 | $0.50 | 2 | NQ |
| ES | CME | 0.25 | $50 | $12.50 | 50 | — |
| MES | CME | 0.25 | $5 | $1.25 | 5 | ES |
| GC | COMEX | 0.10 | $100 | $10.00 | 100 | — |
| MGC | COMEX | 0.10 | $10 | $1.00 | 10 | GC |
| CL | NYMEX | 0.01 | $1000 | $10.00 | 1000 | — |
| MCL | NYMEX | 0.01 | $100 | $1.00 | 100 | CL |

**Symbol mapping is not a static table.** The Rithmic **exchange code** = registry `exchange`
(CME/COMEX/NYMEX); the authoritative **trading symbol** is resolved at runtime from Rithmic
reference discovery (`reconcileReferenceData`, `parseReferenceData` reading
`min_qprice_change` / `single_point_value` / `trading_symbol`) and **validated against Atlas
canonical** — discrepancies are reported, Atlas is never overwritten. Verifying real Test symbols
resolve and match is an **OWNER-MANUAL** item (§9).

---

## 7. Provider-health vocabulary the owner reads (PROVEN)

- **Infra health** (`infra/health.ts`, `buildInfraHealth`) → `posture.rithmic`: `configState`
  (`CONFIGURED`/`UNCONFIGURED`), redacted `description`, `enabled`, `environment`, `systemName`,
  `endpointHost` (host only), `marketDataEnabled`, `executionEnabled`, bounded `metrics`.
  Tested `health.test.ts` ("never leaks a credential").
- **Ops-IO provider status** (`platform/ops-io.ts`) → `provider: 'RITHMIC'`, `configured: r.ok`,
  **`verified: false`** with note *"live acceptance (auth/market/route/exec) not confirmed"*.
- **System-Doctor** (`platform/system-doctor.ts`, `checkRithmic`): `NOT_CONFIGURED` when unconfigured;
  when configured → **`NOT_VERIFIED`** (expected: *"authenticated + market/historical/route/execution
  verified (live acceptance)"*). Tested `system-doctor.test.ts`.
- **Feed status** (`rithmic/domain/freshness.ts`): `CONNECTED · STALE · RECONNECTING · DISCONNECTED`.

**The posture deliberately stops at `NOT_VERIFIED` / `verified: false` until a live Rithmic Test
session is run.** A mock can never read as "healthy," and a configured-but-unauthenticated Rithmic
can never read as "verified." That is the truth the owner console shows today.

---

## 8. No fallback masking — CONFIRMED (PROVEN)

`marketdata/bootstrap.ts` `buildConfiguredProvider` selects strictly by
`env().MARKET_DATA_PROVIDER`, never inferred from key presence:
- `rithmic` branch calls `resolveRithmicConnection()`; if `!ok` it **throws**
  `MARKET_DATA_PROVIDER=rithmic but Rithmic is not configured (...)` — no silent swap to
  yahoo/replay.
- `databento` branch throws if `DATABENTO_API_KEY` missing.
- At the provider layer, `RithmicMarketDataProvider.connect` throws if `!ok` or
  `!marketDataEnabled`; `getConnectionStatus` reports `DISCONNECTED / UNCONFIGURED`, never
  `CONNECTED`; `getQuote` returns `null`, never fabricates. Execution mirrors this.

Nothing is ever labeled Rithmic while serving another feed. **No masking, no mislabeling, no
fabricated CONNECTED/quotes/bars/fills, no credential exposure to the browser were found.**

---

## 9. OWNER MANUAL REQUIRED — the live Rithmic Test acceptance checklist

These require a real, authenticated **Rithmic Test** session and **cannot** run in this container
(no credentials, by policy). Run them locally with credentials present; **CI must never require
personal credentials.** Do **not** call Rithmic Test production-ready until every box is checked
by the owner. Where a step needs visual confirmation against **R\|Trader Pro**, that is an
**OWNER MANUAL REFERENCE REQUIRED** step (Nate must eyeball the reference terminal).

Setup (one-time): drop the official RProtocolAPI proto into `vendor/rithmic/proto` (or set
`RITHMIC_VENDOR_DIR`), run `pnpm rithmic:generate` then `pnpm rithmic:verify`; set `RITHMIC_ENABLED=true`,
`RITHMIC_ENVIRONMENT=TEST`, `RITHMIC_ENDPOINT`, `RITHMIC_SYSTEM_NAME`, credentials, and the
market-data/execution enable flags. Never commit any of these.

- [ ] **Official schema conformance:** `rithmic:verify` passes against the official proto (id↔name
      bijection, no hardcoded ids). *(closes the test-double → official gap in §2)*
- [ ] **Discovery:** `RequestRithmicSystemInfo` returns systems and the configured "Rithmic Test"
      system is present (not `SYSTEM_ABSENT`).
- [ ] **Auth:** each plant (TICKER/ORDER/HISTORY/PNL) reaches `AUTHENTICATED`; `allHealthy()` true;
      owner health flips `NOT_VERIFIED` → verified only after this pass.
- [ ] **Heartbeat/liveness:** server heartbeat interval honored; no false DEGRADED under a live idle.
- [ ] **Live market data:** subscribe NQ (+ one micro, one non-CME e.g. GC or CL); confirm real
      `LastTrade`/`BBO` arrive, timestamps are sane ms, freshness reads `CONNECTED`, and it degrades
      to `STALE`/`RECONNECTING` correctly on interruption. **OWNER MANUAL REFERENCE:** prices match
      R\|Trader Pro.
- [ ] **Historical bars:** replay bars for at least two timeframes; confirm dedup and that
      historical→live handoff shows no dup/backward/phantom bar. **OWNER MANUAL REFERENCE:** bar
      shapes match R\|Trader Pro.
- [ ] **Reference data:** each launch root's Test trading symbol resolves and validates against Atlas
      canonical (tick size / point value); discrepancies reported, Atlas not overwritten.
- [ ] **Order path (Test account only):** submit → ack (ack ≠ fill) → fill → position → account P&L;
      then modify and cancel; confirm dedup and that a simulated lost ack yields `SUBMISSION_UNKNOWN`
      (never a blind resubmit). **OWNER MANUAL REFERENCE:** order/position/P&L match R\|Trader Pro.
- [ ] **Reconciliation:** run order + position reconcile against the live Test account; verdicts
      MATCHED where expected; provider-only rows flagged REQUIRES_REVIEW, never invented.
- [ ] **Credential safety under live load:** confirm no credential appears in logs, health, metrics,
      the browser bundle, or any error surfaced to the console.

Until all boxes are checked by the owner, Rithmic stays **TEST-only, NOT_VERIFIED**, and is not
wired to any production Rithmic system.

---

## 10. Deterministic evidence run (this acceptance, HEAD `b2936c8`)

All green, no live credentials, `NODE_ENV=test`:

| Suite | Command scope | Result |
|---|---|---|
| Rithmic (protocol/connection/execution/market-data/reconcile/metrics/torture) | `vitest run src/rithmic` | **107 passed** |
| Market-data + provider health + execution + P&L oracle/reconciliation | `vitest run src/marketdata src/infra/providers.test.ts src/infra/health.test.ts src/execution src/trading/money-oracle.test.ts src/trading/pnl-reconciliation.test.ts` | **127 passed** |
| Instruments registry (8 roots, 10:1 micro economics, tick/fee math) | `@atlas/instruments vitest run` | **100 passed** |
| Owner health vocabulary (system-doctor + ops-io) | `vitest run src/platform/system-doctor.test.ts src/platform/ops-io.test.ts` | **23 passed** |
| **Phase 5 Golden Path regression (must stay green)** | `vitest run src/platform/golden-path.core50k.test.ts src/platform/golden-path.security.test.ts` | **17 passed** |

Credential safety re-scan: only `apps/server/.env.example` (placeholders) is tracked; **zero**
Rithmic credential references in `apps/web` (only redacted posture rendering in the Infra page);
no `.env` committed; no live host contacted.

---

## 11. Non-blocking findings (recorded, not fixed this phase)

1. **Dead/confusing guard** — `rithmic/plants/market-data-service.ts`: `nb.time * 1000 >= 0` is a
   nonsensical bound (`nb.time` is already ms; ×1000 → µs, always ≥ 0 for a positive time).
   Harmless. Verify start/finish index units against the official docs during the live pass.
2. **Cosmetic dead ternary** — `execution/providers/rithmic-execution.ts`: `discoverAccounts(c.credentials ? '' : '')`
   both branches yield `''`. No functional impact.
3. **Behavioral (intended)** — Rithmic BBO quotes carry `last: null`; bars are trade-driven only
   (see §4). Confirm on the live feed.

Tracked as **HTF-23** in `KNOWN_ISSUES.md` (cosmetic Rithmic cleanups; non-blocking).

---

## PROVENANCE

Compiled from a read-only implementation map of `apps/server/src/rithmic/**`,
`apps/server/src/marketdata/**`, `apps/server/src/execution/**`, `packages/instruments/**`, and
the owner-health surfaces (`infra/health.ts`, `platform/ops-io.ts`, `platform/system-doctor.ts`),
cross-checked against the deterministic test suites listed in §10 which were executed for this
acceptance. No live Rithmic session was run; no credentials exist in this environment. Live items
are classified **OWNER MANUAL REQUIRED** and are not marked verified from code.
