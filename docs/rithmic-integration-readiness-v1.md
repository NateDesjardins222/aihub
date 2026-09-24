# Rithmic Integration Readiness V1

**Milestone 4.** What exists in Atlas for a future Rithmic (R | Protocol)
connection, what is deliberately absent, and exactly what is required — from
Rithmic and from us — before a single order could reach a Rithmic gateway.

> **Atlas does not connect to Rithmic today, and this document is not a claim of
> Rithmic conformance or CME redistribution rights.** It is an honest readiness
> statement: the *seams* are built so the *wire integration* can be added later
> without architectural surgery.

---

## 1. What is built (the honest scaffold)

| Piece | File | State |
| --- | --- | --- |
| Execution adapter | `apps/server/src/execution/providers/rithmic-execution.ts` | Implements `ExternalExecutionAdapter`. UNCONFIGURED without server config; `connect()` throws `PROVIDER_UNCONFIGURED`. With config present it reaches a clearly-marked seam that throws `NOT_SUPPORTED` — **it never fakes CONNECTED.** |
| Market-data adapter | `apps/server/src/marketdata/providers/rithmic.ts` | `DescribableProvider` scaffold, mode `REALTIME`, UNCONFIGURED, `connect()` throws, `getQuote()` null. Never fabricates. |
| Config resolver | `apps/server/src/infra/rithmic-config.ts` | Reads `RITHMIC_*` from env, returns `CONFIGURED` or `UNCONFIGURED { missing: [...] }`. Exposes `redactedRithmicDescription()` — never leaks user/password/ids. |
| Connection lifecycle | `apps/server/src/infra/connection-lifecycle.ts` | `BackoffPolicy`, `backoffDelayMs`, `mayRetry`, `HeartbeatWatchdog` — reusable reconnect/heartbeat machinery the real transport will use. |
| Registry wiring | `apps/server/src/execution/registry.ts` + app boot | Rithmic is registered as an external adapter; `externalReadiness('EXTERNAL_*', 'rithmic')` correctly reports "not ready" (UNCONFIGURED / not connected / live-gated). |
| Health surface | `apps/server/src/infra/health.ts` + owner Infrastructure page | Shows Rithmic's config state + a redacted description. |

The whole external-execution state machine (idempotency, ack≠fill, execution
reports, reconciliation, UNKNOWN handling) that Rithmic will drive is already
built, tested against the scripted double, and documented in
`execution-reconciliation-v1.md`.

---

## 2. What is deliberately absent

- **No R | Protocol wire implementation.** The real protocol requires the
  official developer kit / protocol specification, which we do not have and have
  not reverse-engineered.
- **No credentials.** No `RITHMIC_*` values are committed, defaulted, or invented.
- **No live execution.** `EXTERNAL_LIVE_ENABLED` ships `false`; no account is
  mapped to an external mode.
- **No conformance claim.** Rithmic requires a conformance process; none has
  occurred.

---

## 3. Configuration surface (server-side only)

All optional so Atlas boots and tests UNCONFIGURED. All read **server-side**;
never sent to the browser, never logged, never returned by an API.

```
RITHMIC_ENV         # e.g. "paper" | "prod"
RITHMIC_GATEWAY     # gateway host
RITHMIC_SYSTEM      # system name
RITHMIC_USER        # credential  — REDACTED everywhere
RITHMIC_PASSWORD    # credential  — REDACTED everywhere
RITHMIC_FCM_ID      # broker/FCM  — REDACTED everywhere
RITHMIC_IB_ID       # introducing broker — REDACTED everywhere
RITHMIC_APP_NAME
RITHMIC_APP_VERSION
```

`resolveRithmicConfig()` reports exactly which keys are missing (by **name**, not
value) so an operator can see what remains, while `redactedRithmicDescription()`
renders `credentials=present`/`absent` and never the secret itself. This is
verified by tests that set real secret values and assert they never appear in any
snapshot, error, or description.

---

## 4. External blockers (not ours to satisfy in code)

1. **Rithmic developer kit / protocol spec + license.** Required to implement the
   wire transport at all.
2. **Rithmic credentials** for a paper (test) system, then production.
3. **An FCM / broker relationship** (FCM id, IB id).
4. **Rithmic conformance testing** and sign-off before production connectivity.
5. **CME (and other exchange) market-data agreements** if Rithmic market data is
   redistributed or shown beyond entitlement — see
   `market-data-entitlements-v1.md`.

---

## 5. The path to first paper order (when unblocked)

1. Provide `RITHMIC_*` for a **paper** system server-side → `configState()`
   becomes `CONFIGURED`; the owner Infrastructure page shows it.
2. Implement the R | Protocol transport inside `rithmic-execution.ts` behind the
   existing `ExternalExecutionAdapter` methods, using the lifecycle/heartbeat
   helpers. Nothing above the adapter changes.
3. Map a **single internal test account** to `EXTERNAL_PAPER` via the admin
   mapping (`setMapping`) — audited, exposure-guarded, never from the browser.
4. Exercise the existing safety gate + external-order state machine +
   reconciliation against the paper venue. The scripted torture suite already
   proves the Atlas side; this proves the wire.
5. Only after conformance + explicit business decision does
   `EXTERNAL_LIVE_ENABLED` become relevant — and even then it is a separate,
   deliberate, server-side switch.

At no point in this path does the terminal, risk engine, account system, or copy
trading require a change.
