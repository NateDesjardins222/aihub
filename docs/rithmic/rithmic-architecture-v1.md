# Rithmic Integration Architecture V1 (Milestone 9)

M9 replaces Atlas's development-only delayed-feed path with a **real,
provider-neutral Rithmic Test integration**: the first real external futures
infrastructure integration. It is built behind the market-data and execution
provider seams that M4 established, so nothing above the adapters changes when
Rithmic becomes the source.

> **Rithmic Test is not production live trading.** It is not live capital. M9 does
> not enable global external live trading, does not remove the simulation engine,
> and does not remove the provider abstraction. `EXTERNAL_LIVE_ENABLED` stays
> `false`; a distinct `RITHMIC_*` TEST gate governs the Test path.

---

## 0. The package-authority decision (read this first)

§1 of the M9 spec is emphatic: **the official Rithmic package
`RProtocolAPI.0.90.0.0` is the protocol authority** — do not invent template ids,
enum values, field numbers, or framing. §38 is equally emphatic: **do not commit
Rithmic's proprietary package** (protos, Reference_Guide.pdf, samples) into the
repository.

The official package is **not present in the CI/build environment** used to
implement M9, and it is licensed material that cannot be fetched here. Per §0
("do not block the whole milestone; build the deterministic protocol/provider
implementation first") and §34 (deterministic tests use synthetic frames "based
on official schemas"), Atlas is therefore built so that **the official package is
the runtime authority, supplied locally by the owner**:

1. **`vendor/rithmic/proto/`** (gitignored) — the owner drops the official
   package's `.proto` files here. Nothing proprietary is ever committed.
2. **`pnpm --filter @atlas/server rithmic:generate`** loads those official protos
   with `protobufjs`, derives the template-id ↔ message registry **from the schema
   itself** (each message's `template_id` field default), and writes the bound
   runtime registry into the gitignored `src/marketdata/rithmic/protocol/generated/`.
3. **Atlas code never hardcodes a template id.** The registry
   (`rithmic/protocol/registry.ts`) always derives ids from whatever schema is
   loaded, so the official package silently overrides everything when present.
4. **Deterministic tests** run against a committed **test-double schema**
   (`rithmic/protocol/__fixtures__/atlas-rithmic-min.proto`) that reproduces only
   the message shapes and documented field names Atlas consumes. It is clearly
   labelled a test double; its `template_id` defaults mirror the publicly
   documented R | Protocol ids so tests are realistic, but they are advisory — the
   real values come from the owner's package at `rithmic:generate` time.
5. **`pnpm --filter @atlas/server rithmic:verify`** performs the live Rithmic Test
   acceptance once the package + credentials are present locally, and fails
   gracefully with instructions otherwise.

This keeps every spec constraint simultaneously true: the package is authoritative
(runtime registry from it), nothing proprietary is redistributed (gitignored
vendor + minimal labelled doubles), and the milestone is not blocked (the full
transport, plants, normalization, reconciliation, risk integration, UI and 100+
deterministic tests are all built and green against the doubles).

**The framing** (4-byte big-endian length prefix + protobuf body) is implemented
in one module (`rithmic/protocol/framing.ts`) with a single `LENGTH_PREFIX_BYTES`
constant, so if the package's samples document a different width it is a one-line
change and `rithmic:verify` validates it against the real gateway.

---

## 1. Layering

```
Rithmic Test gateway (wss://…rithmic.com:443)
        │  R | Protocol over WebSocket (length-prefixed protobuf)
        ▼
rithmic/transport/*          — WebSocket transport (real ws + deterministic mock)
        ▼
rithmic/protocol/*           — framing · registry(codec) · router   (schema-driven)
        ▼
rithmic/plants/*             — per-plant connection state machines + discovery/auth/heartbeat
        ▼
rithmic/domain/*             — normalize Rithmic facts → Atlas canonical model
        ▼
marketdata/providers/rithmic.ts   +   execution/providers/rithmic-execution.ts
   (existing MarketDataProvider / ExternalExecutionAdapter seams — unchanged shape)
        ▼
Atlas bus · chart · engine · risk · accounts · reconciliation
```

No Rithmic protobuf type escapes `rithmic/domain/*`. Everything above consumes
`NormalizedQuote/Trade/Bar` and `ExecutionReport/ExternalAck` exactly as the
scripted double and Yahoo feed do.

---

## 2. Connection model — distinct plants

R | Protocol defines distinct infrastructure types. Atlas models each as its own
logical connection with its own state machine (never one ambiguous socket):

| Plant | infra_type | Purpose |
| --- | --- | --- |
| DISCOVERY | — | `RequestRithmicSystemInfo` → system names, then closes |
| TICKER | TICKER_PLANT | market data (last trade, BBO, session stats) |
| ORDER | ORDER_PLANT | accounts, trade routes, order lifecycle, executions |
| HISTORY | HISTORY_PLANT | historical bars |
| PNL | PNL_PLANT | positions + P&L |
| REPOSITORY | REPOSITORY_PLANT | (decoded/capable; not required for M9 flow) |

Each connection tracks: `connectedAt`, `authenticatedAt`, `lastMessageAt`,
`lastHeartbeatSentAt`, `lastHeartbeatReceivedAt`, `reconnectCount`,
`lastDisconnectReason`, `lastErrorCode`, `lastErrorAt`. **Passwords never appear**
in any of these, in errors, logs, telemetry, or API output.

State machine: `DISCONNECTED → CONNECTING → CONNECTED → AUTHENTICATING →
AUTHENTICATED → (DEGRADED) → RECONNECTING → FAILED / STOPPED`. A socket being
OPEN is **not** healthy: healthy requires recent valid protocol activity
(heartbeat / message within the liveness window).

---

## 3. Authority split

Atlas remains authoritative for Happy Trader account rules, prop-firm & personal
risk, payout economics, evaluation/funded lifecycle, enforcement holds, customer
identity and accounting. Rithmic is authoritative only for Rithmic-side facts:
transport state, provider market observations, provider order ack/reject,
provider execution/fill reports, provider account ids, provider positions/P&L.

Never conflate: provider **ack ≠ execution**; provider **connection ≠ market
freshness**; a **timeout ≠ rejection** (see `rithmic-execution-lifecycle.md` and
`rithmic-reconciliation.md`).

---

## 4. Safety posture (unchanged invariants)

- Every Rithmic-routed order passes the full Atlas risk pipeline (ownership,
  trade-enabled, firm risk, personal risk, M7 enforcement holds, instrument
  permissions) **before** provider submission. Rithmic RMS is an additional layer,
  not a replacement.
- Copy trading stays provider-neutral: a Rithmic-backed follower is just another
  execution provider; one child's reject never rolls back the others.
- Simulation stays first-class; the Yahoo/dev delayed feed stays available as an
  explicit fallback with a visible source. Atlas never silently swaps a trader
  from Rithmic to Yahoo while presenting it as the same feed.
- No secret is ever committed, logged, returned by an API, or placed in an error.

See the sibling docs: `rithmic-protocol-notes.md`, `rithmic-connection-lifecycle.md`,
`rithmic-market-data.md`, `rithmic-instrument-mapping.md`,
`rithmic-execution-lifecycle.md`, `rithmic-reconciliation.md`,
`rithmic-local-setup.md`, `rithmic-test-acceptance.md`, and the completion report
`m9-rithmic-integration-report.md`.
