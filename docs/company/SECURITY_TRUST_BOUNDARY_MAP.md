# Security Trust Boundary Map

**Security Phase 1** (starting commit `ae9a4a3`). Every boundary is mapped to the
implementation that enforces it. This complements the Phase-10 `SECURITY_MODEL.md`
(the authoritative "what the code enforces") and `THREAT_MODEL.md` (adversary
analysis) — it is the boundary-by-boundary view for the hostile-client attack
programme, verified by re-attack at `ae9a4a3`.

> Honesty: this is what the code enforces today, not a certification. No real
> money, payment rail, payout, KYC, or live provider was touched. Provider
> integrations (Whop/Stripe/Rithmic/Databento/payout) are mock/seam/unconfigured
> and fail closed in production (`SECURITY_MODEL.md` §6, §14).

## The one design law

**The browser may request; it may never assert.** Every authoritative value —
identity, role, ownership, balance, P&L, order state, eligibility, lifecycle —
originates and is decided server-side and is re-read from the DB on the privileged
call. A client is untrusted input, always (`trading/engine.ts:1`, and this
document's rows).

## Boundaries

| Boundary | Trusted inputs | Untrusted inputs | Identity source | Authorization owner | Validation owner | Money authority | Replay protection |
|---|---|---|---|---|---|---|---|
| **Browser → API** | nothing from the client | body, query, params, headers, Bearer token | JWT `sub` verified server-side, then role/status **re-read from DB** (`auth-plugin.ts:46,77`) | per-route `requireUser`/`requireRole`/`requirePermission` (opt-in; §Default-deny) | Zod schemas at each route (`@atlas/contracts`) | never the client | n/a |
| **Session** | server-signed HS256 access JWT (15 min), DB refresh row (30 d, rotating, single-use) | the token bytes | `tokens.ts` verify pins `alg:HS256`+issuer; refresh hash-matched in DB (`service.ts:212`) | `requireUser` | — | — | refresh rotation revokes-in-same-UPDATE; replay detectable via `replacedByTokenHash` |
| **API → DB** | parameterized Drizzle queries only | — | — | domain services re-check ownership (`accounts.userId == caller`) | domain + DB constraints | payout/trading engines under advisory lock + unique ledger key | unique indexes / `onConflictDoNothing` |
| **Owner OS** | operator JWT + DB role rank + step-up token | request body | role re-read; `requirePermission` re-reads effective access (`owner-plugin.ts:39`) | `requirePermission` + `requireReauth(class)` for FINANCIAL/STAFF/KILL_SWITCH | Zod | approve/reject payout, adjust account — all audited | step-up TTL 5 min |
| **Staff** | role rank + per-user permission overrides | request body | `effectiveAccess` from DB | `requirePermission` (granular) | Zod | scoped by permission | — |
| **Commerce webhook (Whop)** | HMAC-SHA256 over raw body, secret from `WHOP_WEBHOOK_SECRET` env | the POST body + headers | Standard Webhooks signature (`whop.ts`) | signature, not a session | signature + Zod | provisioning only from verified event | `commerce_events` unique `(provider, event_id)`; 5-min timestamp window |
| **Payout webhook** | (seam — see finding SEC-3) | POST body | **none today** — `normalizeWebhook(body)`; production fails closed to 202 no-op for mock/unconfigured | terminal/out-of-order guards + unique `(request, entry_type)` ledger | Zod on ingest | never disburses (no real rail) | `payout_provider_events` unique `(provider, event_id)` |
| **Provider adapters** (market data, commerce, identity, notification, payout, execution) | fixed base URLs + env secrets | provider responses | `config/provider-safety.ts` refuses mock in production | central boundary | — | fail-closed in production | — |
| **Outbox / audit** | server-enqueued rows | — | — | worker (idempotent consumer) | — | — | `FOR UPDATE SKIP LOCKED`; audit hash-chain append-only |
| **WebSocket / market gateway** | authenticated handshake + `mayFollowAccount` ownership check | subscription ids | token | `mayFollowAccount` (`ws-security.test.ts`) | — | — | — |
| **Object/file storage** | server-generated random UUID keys, `assertSafeKey` + `resolve` prefix confinement | client `:id` never becomes a storage key | ownership via DB parent lookup | `ownedCertificateArtifact` | key regex | — | — |

## Default-deny audit (Part III)

The authorization architecture is **opt-in, not global default-deny**: a single
global `onRequest` hook (`auth-plugin.ts:46`) only *attaches* `request.user` when a
valid Bearer token is present; it never rejects. Every route is therefore public
unless its plugin/handler opts into `requireUser` / `requireRole` /
`requirePermission`. This is a structurally fail-open default (auth agent risk #8).

**Audit result:** a full route inventory (407 route rows across every plugin) found
**no route accidentally unguarded in a way that exposes another user's private data
or money** — every ownership-scoped plugin uses a plugin-level `requireUser` plus a
per-handler ownership check (`assertOwnership` / `requireOwnAccount` / `userId !==`
guards) or org/identity scoping. The genuinely-public surfaces are intentional:
health/version/ready, instrument reference data, public affiliate landing,
certificate verification, staff-onboarding accept, and the signature/API-key-authed
webhooks + provisioning. See `SECURITY_ENDPOINT_MATRIX.md`.

Because the default is fail-open, the standing risk is a *future* route added
without a guard. `security:check` runs the authorization matrix suites as the
regression that would catch a customer/owner boundary regression.

## Findings from the boundary map (see `SECURITY_PHASE1_REPORT.md`)

- **SEC-1 (P2, FIXED)** — the step-up (`/admin/security/reauth`) password gate had
  no rate limit; now capped 10/min per IP.
- **SEC-2 (P2, documented)** — market-data replay/recording/provider controls are a
  customer-facing Atlas feature but implemented as a **global singleton**, so one
  customer's replay/provider switch affects every tenant's chart feed. Market-data
  display only — no money/authz/private-data. A proper fix (per-session replay
  isolation) is an Atlas market-data redesign, out of Phase-1 scope.
- **SEC-3 (P3 / pre-launch gate)** — the payout webhook has no signature
  verification (a seam); production fails closed to a no-op. Must gain raw-body
  signature verification before any real payout rail ships.
- **SEC-4 (P3)** — `POST /admin/users/:id/notes` runs at SUPPORT while sibling
  redaction requires ADMIN; confirm intended role granularity.
