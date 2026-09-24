# Production Trading Infrastructure V1 — completion report

**Milestone 4.** Provider-neutral market-data + production execution
infrastructure so Atlas can eventually connect to professional futures
infrastructure (Rithmic the likely primary execution path; Databento a
market-data option) **without rewriting the terminal, risk engine, account
system, or copy trading** — and without enabling real-money trading, inventing
credentials, or claiming conformance.

- **Starting HEAD:** `2fe08f6` (Milestone 3 — Copy Trading V1 closure)
- **Ending HEAD:** `ef224d2` (+ this report)
- **Default execution mode:** `SIMULATION` (unchanged, and the only reachable
  mode this milestone)
- **Professional providers:** `UNCONFIGURED`, boot-safe, never faking connectivity

---

## 1. What shipped

| Area | Delivered |
| --- | --- |
| **Contracts (M4-B)** | `packages/contracts/src/infrastructure.ts` — provider-neutral infrastructure types: config/health states, provider kinds, capabilities, health snapshots, execution modes, account↔provider mapping, external order + reconciliation states, session states, entitlements. New reject reasons (`MARKET_DATA_DISCONNECTED`, `CONTRACT_EXPIRED`, `EXECUTION_PROVIDER_UNAVAILABLE`). |
| **Reference data (M4-G/H/I)** | `Symbology` (bidirectional, contract-aware, `assertExecutable` guard), `SessionAuthority` (OPEN/CLOSED/PRE_OPEN/MAINTENANCE/HALTED/UNKNOWN + halts), `RolloverEngine` (front/next/prev, phase). |
| **Provider seams (M4-D/F/W)** | Market-data Rithmic scaffold (UNCONFIGURED); execution `ExternalExecutionAdapter` seam + Rithmic scaffold; `ExecutionRegistry` routing; Scripted test doubles for both; Rithmic config resolver + redaction; connection-lifecycle (backoff, heartbeat). |
| **Durable state + services (M4-N/O/P/Q/S)** | Migration 0022 (6 additive tables). `external-orders` (idempotency, ack≠fill, dedup, monotonic fills, UNKNOWN), `reconciliation` (IN_SYNC/RECONCILIATION_REQUIRED/UNKNOWN), `provider-mapping` (default SIMULATION, audited, exposure-guarded), `entitlements` (UNKNOWN-by-default), `safety-gate` (fails closed with specific reasons). |
| **Health + owner surface (M4-T/Z)** | `buildInfraHealth` (redacted posture + per-provider health), `GET /api/v1/admin/infra`, owner **Infrastructure** page (read-only). |
| **Terminal UX (M4-Y)** | Account-bar data-mode badge driven by the server's authoritative connection status (REALTIME/DELAYED/REPLAY/DISCONNECTED); SIM badge retained; no LIVE/PAPER execution badge is ever shown. |
| **App wiring (M4-AC)** | Registry (sim engine + honest Rithmic seam) wired into boot; UNCONFIGURED-safe; default SIMULATION. |
| **Docs (M4-A/AF)** | `production-trading-infrastructure-v1.md`, `provider-contracts-v1.md`, `rithmic-integration-readiness-v1.md`, `market-data-entitlements-v1.md`, `execution-reconciliation-v1.md`, and this report. |

Commits (9): `56cddd7` (M4-A) · `9855eab` (M4-B) · `72c4a39` (M4-G/H/I) ·
`50e6d9b` (M4-D/F/W) · `b49ba3b` (M4-N/O/P/Q/S) · `b33e1f9` (M4-X) · `735fd1a`
(M4-T/Z/AC) · `c076e46` (M4-Y) · `ef224d2` (M4-AF). 43 files, +4,625 lines.

---

## 2. Tests

Correctness is proven **deterministically** — not by hoping a real-clock replay
fill lands during a browser run.

| Suite | Result |
| --- | --- |
| Reference data (symbology/session/rollover) | 12/12 |
| Provider scaffolds + registry + redaction | 5/5 |
| `env` config | pass |
| Domain services (mapping/orders/reconciliation/entitlements/gate) | 9/9 |
| **External-execution torture suite (M4-X)** | **37/37** |
| Infra health + redaction (M4-T/AA) | 1/1 |
| Admin routes (regression, inc. `/infra`) | 51/51 |
| Copy-trading regression | 45/45 |
| Web typecheck / server typecheck | clean / clean |
| Web production build | success |

Full server suite: 734 tests — **731 pass**; the 3 that don't are
real-clock-sensitive **trading-engine** tests (`adversarial`, `engine`,
`rules.integration`, `determinism`). They are flaky under CPU load (10 fail in a
fully parallel run, 3 in a sequential run, and a couple even file-alone under a
busy machine — determinism, by contrast, passes 3/3 file-alone). **Milestone 4
changed zero files under `src/trading/`** (verified: `git diff --name-only
2fe08f6..HEAD` lists nothing there), so these are pre-existing, load-dependent
flakes in the real-clock engine harness — precisely the failure mode this
milestone was told not to rely on for proof. M4 execution correctness is
established by the **deterministic** suites above (37/37 torture, 9/9 domain,
12/12 reference, 5/5 providers, 51/51 admin, 45/45 copy), never by a real-clock
fill landing on time.

---

## 3. Hard boundaries honored

- **No real-money / live execution.** `EXTERNAL_LIVE_ENABLED` ships `false`; no
  account is mapped externally; default mode is SIMULATION.
- **No invented credentials, no reverse-engineering, no conformance claim.**
  Rithmic is an honest UNCONFIGURED scaffold.
- **Credentials are server-side only** — never in the browser, DB plaintext,
  logs, errors, or committed files. Verified: no secret values committed, no
  `.env` tracked, `RITHMIC_*` read only via `env()`, web bundle contains no
  server config, and redaction is asserted with real secret values set.
- **One P&L engine, one execution engine, one copy-trading path.** The
  simulation `ExecutionProvider` is untouched; the async
  `ExternalExecutionAdapter` is a separate seam, not a second engine.
- **Atlas stays the P&L authority.** Ack ≠ fill; lost ack → UNKNOWN;
  reconciliation never assumes an order vanished; nothing silently switches
  providers, clamps size, or recovers an uncertain external order.
- **The browser can never select EXTERNAL or a provider.** Mode/provider live in
  a durable, server-side, audited mapping; the terminal never shows a
  live-execution badge.
- **Simulation + copy trading unbroken.** 45/45 copy tests; no `src/trading/`
  file changed; terminal unchanged except a truthful data-mode badge.

---

## 4. Rithmic / Databento readiness

- **Rithmic (execution, likely primary):** seam + adapter + config + lifecycle +
  full order/reconciliation state machine built and tested against the scripted
  double. **Blocked externally** on the R\|Protocol dev kit + license,
  credentials, an FCM relationship, and conformance. See
  `rithmic-integration-readiness-v1.md`.
- **Databento (market data option):** adapter present from Milestone 3 (historical
  HTTP + live DBN seam); selectable via `MARKET_DATA_PROVIDER`. Realtime use is
  gated by the entitlement domain (`market-data-entitlements-v1.md`) and the
  redistribution posture (ships `none`).

---

## 5. External blockers

1. Rithmic developer kit / protocol spec + license.
2. Rithmic paper + production credentials; FCM / IB relationship.
3. Rithmic conformance sign-off.
4. Exchange (CME et al.) market-data agreements for any professional real-time
   redistribution.

None are code; all are commercial/legal prerequisites. Atlas is architecturally
ready to consume them without further surgery.

---

## 6. Known limitations

- No wire transport to any external venue yet (by design).
- The entitlement domain exists but does not yet gate a live feed, because no
  professional real-time feed is served (Yahoo delayed, redistribution `none`).
- The owner Infrastructure page is read-only; changing an account's mapping is a
  server-side/admin action (`setMapping`), intentionally not exposed as a UI
  control in this milestone.
- A handful of pre-existing real-clock trading-engine tests
  (`adversarial`/`engine`/`rules.integration`/`determinism`) flake under CPU
  load; they are outside this milestone's changed files and are not a regression.

---

## 7. Next milestone (suggested)

Implement the Rithmic R\|Protocol transport behind the existing
`ExternalExecutionAdapter` (paper first), exercise the built safety-gate +
order + reconciliation machinery against the paper venue, and add live
end-to-end reconnect/recovery tests — all without touching the terminal, risk
engine, account system, or copy trading.
