# Market Data Entitlements V1 — the software domain

**Milestone 4.** The entitlement domain Atlas consults before it would serve
professional real-time market data.

> **This is software, not law.** It is NOT legal advice, NOT permission to
> redistribute, NOT an exchange agreement, and NOT a substitute for a CME (or
> other exchange) market-data license. It is the mechanism by which Atlas
> *refuses to serve data it cannot prove it may*. The compliance posture itself
> is declared separately (`MARKET_DATA_REDISTRIBUTION`, see
> `market-data-licensing-gate.md`).

---

## 1. Why it exists

Professional exchange data is entitled per user, per exchange, per data level,
and often per display/non-display use. Serving it without the entitlement is a
licensing violation. Atlas therefore treats the **absence** of a provable
entitlement as `UNKNOWN` — never as permission. The default answer is "no".

---

## 2. The model

Table `market_data_entitlements` (migration 0022). Types in
`packages/contracts/src/infrastructure.ts`; logic in
`apps/server/src/platform/entitlements.ts`.

| Concept | Type | Values |
| --- | --- | --- |
| Exchange | `EntitlementExchange` | `CME` \| `CBOT` \| `NYMEX` \| `COMEX` |
| Data level | `EntitlementDataLevel` | `DELAYED` \| `REALTIME_TOP` \| `REALTIME_DEPTH` |
| Display use | `EntitlementDisplayUse` | `DISPLAY` \| `NON_DISPLAY` |
| Status | `EntitlementStatus` | `UNKNOWN` \| `ENTITLED` \| `NOT_ENTITLED` \| `PENDING` |

Row fields include `organizationId`, nullable `userId` (a null user row is an
org/exchange-wide default), `status`, `providerEntitlementRef` (the provider's own
entitlement id, when there is one), `effectiveAt`, `expiresAt`.

---

## 3. Resolution rules (`entitlementStatus`)

Given a user, exchange, and data level:

1. **No matching row → `UNKNOWN`.** Atlas never silently serves real-time data it
   cannot prove it may. This is the safety default.
2. **A user-specific row wins** over an org/exchange-wide row.
3. If the chosen row is **not yet effective** (`effectiveAt` in the future) →
   `PENDING`.
4. If the chosen row is **expired** (`expiresAt` in the past) → `NOT_ENTITLED`.
5. Otherwise the row's stored `status`.

`upsertEntitlement` records/updates a row. Both are covered by the domain tests
and the torture suite (`UNKNOWN` default, `ENTITLED`, `PENDING`, `NOT_ENTITLED`).

---

## 4. What Milestone 4 does and does not do with it

**Does:** builds the domain, the table, the resolution rules, and the
`UNKNOWN`-by-default guarantee, so the check exists and is correct the day
professional real-time data is turned on.

**Does not:** gate the *current* feed. Atlas today serves a **delayed**
development feed (Yahoo) whose redistribution posture is `none`. No professional
real-time exchange data is served, so no entitlement is consumed yet. Wiring the
resolver in front of a real-time provider is a later, deliberate step — and it
fails closed (`UNKNOWN`/`NOT_ENTITLED` → do not serve).

---

## 5. Relationship to other pieces

- **Redistribution posture** (`MARKET_DATA_REDISTRIBUTION`: `none` |
  `internal` | `delayed-external` | `realtime-external`) is a firm-level
  compliance *declaration*, surfaced on the owner Infrastructure and System
  pages. It ships `none`. Entitlements are the *per-user* mechanism beneath it.
- **Providers** never assert entitlement themselves; Atlas asks this domain.
- **Execution** is unrelated — entitlement governs *seeing* data, not *trading*.
  A trade is gated by the execution safety gate, not by this table.
