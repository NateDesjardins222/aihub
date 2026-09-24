# Execution Reconciliation V1 — Atlas stays the P&L authority

**Milestone 4.** How Atlas keeps its own record of external orders truthful
against a venue it does not control, and how it behaves when the two disagree.

> **Atlas is the P&L authority in every mode.** An external venue is a *source of
> execution reports*, never a second P&L engine. Atlas never guesses that an
> order vanished, never silently resets external state, and never treats a
> transport success as a fill.

Code: `apps/server/src/platform/external-orders.ts`,
`apps/server/src/platform/reconciliation.ts`,
`apps/server/src/execution/safety-gate.ts`. Schema: migration 0022. Proof:
`production-infra.test.ts` + the 37-case torture suite
(`production-infra.torture.test.ts`).

---

## 1. The external order lifecycle

State machine (`ExternalOrderState`): `PENDING_SUBMIT` → `SUBMITTED` →
`ACKNOWLEDGED` → `PARTIALLY_FILLED` → `FILLED`, with `PENDING_CANCEL`,
`CANCELED`, `REJECTED`, and `UNKNOWN` as terminal/aside states.

- **Record once** (`recordExternalOrder`). The client order id is a **unique
  idempotency key**; a retried command reuses the existing row and returns
  `created: false`. Atlas ids are canonical; the provider order id is stored
  separately and is never authority to the browser.
- **Submit is not a fill** (`markSubmitted`). Recording the transport ack links
  the provider order id and advances to `SUBMITTED`/`ACKNOWLEDGED` only.
- **Reports advance state** (`applyExecutionReport`). Every accepted report is
  appended to an audit trail (`external_execution_events`). Duplicates are
  suppressed by a **dedupe key**. Filled quantity is **monotonic** — a stale or
  duplicate report can never reduce it (`Math.max`).
- **A lost acknowledgement is `UNKNOWN`** (`markUnknown`), never assumed filled
  or canceled. The truth is recovered by reconciliation.

---

## 2. Reconciliation

`reconcileAccount(db, accountId, providerAccountId, adapter)` compares Atlas's
recorded working orders against the venue's authoritative snapshot
(`adapter.listWorkingOrders`).

| Situation | Result |
| --- | --- |
| Venue matches Atlas | `IN_SYNC` |
| Atlas has a working order the venue does not show | `RECONCILIATION_REQUIRED` |
| Venue shows an order Atlas does not know | `RECONCILIATION_REQUIRED` |
| Atlas order has no provider id (unacknowledged) | discrepancy → `RECONCILIATION_REQUIRED` |
| **Venue unreachable** | `UNKNOWN` — never `IN_SYNC`, never "the order vanished" |

The result and its discrepancies are persisted (`reconciliation_state`) and
readable (`getReconciliationState`). `RECONCILIATION_REQUIRED` / `UNKNOWN` are
operator-actionable states; dangerous automatic actions are restricted upstream
until an operator resolves it. Atlas **never silently repairs** external state —
repair is an administrative act with an audit trail, mirroring the existing
ledger-audit philosophy.

---

## 3. The external execution safety gate

Before any order could leave Atlas for an external venue,
`externalExecutionGate` validates the production-infrastructure preconditions the
account-level risk engine does not itself cover. It is **additional** defense —
the existing Atlas risk engine remains authoritative for account state, sizing,
limits, and market/staleness gates. It **fails closed with a specific reason**,
never a generic "order failed":

1. `SIMULATION` → always allowed (nothing external to guard; the engine + risk
   are authority).
2. Suspended mapping → `EXECUTION_PROVIDER_UNAVAILABLE`.
3. Contract validation (`symbology.assertExecutable`) → `CONTRACT_EXPIRED` /
   `UNKNOWN_INSTRUMENT` / `INSTRUMENT_NOT_PERMITTED` (e.g. an `NQ` contract code
   under `MNQ`).
4. Session authority — only an `OPEN` market may route → `MARKET_CLOSED`.
5. Freshness — never route into an absent/stale feed → `MARKET_DATA_UNAVAILABLE`
   / `MARKET_DATA_STALE`.
6. Provider readiness (configured + connected + the `EXTERNAL_LIVE` gate) →
   `EXECUTION_PROVIDER_UNAVAILABLE`.

The browser can only express intent. Provider name, execution mode, provider
account id, entitlement, and contract mapping are **never** trusted from the
client; the gate reads them server-side from the durable account↔provider
mapping.

---

## 4. Account ↔ provider mapping

`provider_account_mappings` (migration 0022);
`apps/server/src/platform/provider-mapping.ts`.

- The **default, and the value for any unmapped account, is `SIMULATION`.** A
  customer can never self-promote to external execution.
- Moving an account to `EXTERNAL_PAPER`/`EXTERNAL_LIVE` is an explicit
  **server-side administrative** action (`setMapping`), **audited**
  (`provider.mapping.changed`).
- **Exposure guard:** a mapping change is refused while the account holds an open
  position (`ACCOUNT_EXPOSED`) — you cannot strand a position between venues.
  Change it while flat.
- Copy trading is unaffected: it addresses accounts by Atlas id and asks the
  mapping/registry per account.

---

## 5. Why this is not the Milestone-3 mistake

Execution correctness here is proven by **deterministic server tests and a
37-case torture suite** driven by the scripted double — not by hoping a
real-clock replay fill lands during a browser run. Browser acceptance proves
browser behavior; execution correctness proves itself deterministically. The
scripted adapter can produce ack-without-fill, partial/late fills, rejects,
duplicate reports, and reconciliation snapshots that deliberately disagree with
Atlas — every path the real venue will exercise, on demand, repeatably.
