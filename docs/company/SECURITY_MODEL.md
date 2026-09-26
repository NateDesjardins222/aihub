# SECURITY MODEL

**Happy Trader Funding — the trust boundaries the platform actually enforces, each mapped to code and to a proving test.**

Phase 10 (2026-09-26) — security + adversarial hardening. Baseline HEAD at phase entry: `5072596`.

> **Scope & honesty.** This is the authoritative description of *what the code enforces today*, not a
> certification. Happy Trader Funding is **not** claimed to be unhackable, PCI/SOC-2 compliant, or
> production-certified. Legal, payments, and KYC boundaries are held at or below READY FOR TEST until
> proven in the real environment by the responsible owner (`LAUNCH_GATES.md`). No real money, real
> payment rail, real payout, or production/live Rithmic was touched in this phase; all evidence is from
> deterministic tests and dev/sandbox fixtures. No discovered secret value is printed in this document.

This document synthesizes and extends the earlier security work — `security-role-matrix.md`,
`security-production-hardening-v1-plan.md`/`-report.md`, `security-failure-ledger.md` — with the
Phase 4 (fail-closed providers), Phase 7 (self-serve gating + kill-switch enforcement), Phase 9
(financial integrity), and Phase 10 (adversarial hardening) additions.

---

## 1. Design principle: the server is the only authority

The browser **may request; it may never assert.** Every number that matters — balance, P&L, order
state, eligibility, role, ownership — originates and is decided server-side. The trading engine states
it in its own header (`trading/engine.ts:1-11`); the same principle governs money, RBAC, and lifecycle.
A client is untrusted input, always.

Consequences that are enforced, not assumed:
- **No client-supplied identity.** Role and ownership are re-read from the DB on every privileged call,
  never taken from a token claim or request body.
- **No client-driven money.** Provisioning happens only from a server-verified provider event, never
  from a browser "success" screen (`commerce.ts`, `onboarding.ts` dev-sim routes prove the path).
- **No client-weakened rules.** A trader cannot edit the risk rules they are judged by on a
  commercial account (Phase 7, §4 below).

---

## 2. Authentication & session

| Property | Enforcement | Proving test |
|---|---|---|
| Password hashing | argon2/bcrypt via `auth/password.ts` (`hashPassword`) | auth suites |
| Login rate-limit | Fastify `rateLimit`, per-route caps; global 600/min | `security.test.ts`, `authz-security.test.ts` |
| No user enumeration | login failures are indistinguishable (same shape/timing posture) | `authz-security.test.ts` |
| Role/status re-read | `requireRole` re-reads current role + status from DB; a revoked role or `DISABLED` user is denied even with a cryptographically valid token | `owner-authz-http.test.ts`, `rbac.test.ts` |
| Refresh revocation | disabled user's refresh is blocked immediately | `authz-security.test.ts` |
| JWT secret | `JWT_SECRET` from env only (≥32 chars enforced by `config/env.ts`); never in the client bundle | bundle scan (§9) |

---

## 3. Authorization: RBAC + tenant isolation + IDOR

Roles are rank-ordered (`TRADER 0 < SUPPORT 1 < ADMIN 2 < SUPER_ADMIN 3`); `requireRole(minimum)`
compares rank. The full capability matrix is `security-role-matrix.md`.

- **`self` scope** — a trader may act only on `accounts.userId == caller`; a foreign resource is a
  **404 with no existence oracle** (fail-closed, no "403 vs 404" leak).
- **`org` scope** — owner reads/mutations are scoped to `organizationOf(caller)`; a cross-org resource
  is a 404.
- **IDOR / mass-assignment** — request bodies are Zod-parsed to explicit shapes; no pass-through of
  `userId`/`organizationId`/`role`/`status` from the client.

Proving tests: `m10-1-rbac-redteam.test.ts`, `enforcement-authz.test.ts`, `affiliate-security.test.ts`,
`owner-authz-http.test.ts`, `golden-path.security.test.ts`, `rbac-permissions.test.ts`. Customer-A vs
Customer-B cross-tenant reads/writes, and TRADER→`/admin/*` escalation, are all denied 403/404.

---

## 4. Self-serve boundary (Phase 7 — HTF-21)

A trader must not be able to weaken the constraints they are evaluated against. `assertSelfServeMutable`
(`trading.ts`) throws `403 SELF_SERVE_FORBIDDEN` unless the account is `PRACTICE`. It gates:
`PUT /accounts/:id/rules`, `POST /accounts/:id/reset`, `PUT /accounts/:id/environment`.

- `PRACTICE` (free playground) → allowed.
- `EVALUATION | FUNDED | FUNDED_SIM` (commercially-weighted) → 403; the override is **never persisted**;
  a non-owner gets 404.

Proving test: `self-serve-boundary.test.ts` (6 tests).

---

## 5. Kill switches enforce (Phase 7 — HTF-24)

Six money/lifecycle switches actually block at their server chokepoints via `assertNotEngaged(db, key)`
→ **HTTP 423 `KILL_SWITCH_ENGAGED`** (engaging one has real effect, not just an audit event). Engaging
requires a reason (≥3 chars) and is itself audited.

| Key | Chokepoint |
|---|---|
| `DISABLE_NEW_PURCHASES` | `commerce.ts` createPendingOrder |
| `DISABLE_PROVISIONING` | `provisioning.ts` provisionAccount |
| `DISABLE_NEW_ORDERS` | trading order entry |
| `DISABLE_NEW_PAYOUT_REQUESTS` | `payouts.ts` requestPayout |
| `DISABLE_PAYOUT_SUBMISSION` | `payout-operations.ts` submitPayable |
| `DISABLE_EXTERNAL_EXECUTION` | execution safety gate |

Proving test: `kill-switch-enforcement.test.ts` (6 tests; each money switch rejects its chokepoint;
engage/release round-trips).

---

## 6. Provider safety: fail-closed in production (Phase 4)

"No real money" is a property of the **code**, not the config. The central boundary
(`config/provider-safety.ts`) refuses the mock in production:

- **Commerce** — production without Whop returns the seam (`isConfigured()===false`, webhook 503s); a
  direct mock payment throws `MOCK_COMMERCE_FORBIDDEN`. No fabricated `PAYMENT_SUCCEEDED`.
- **Identity/KYC** — production without Stripe returns the seam whose `createVerification` throws. No
  fabricated `IDENTITY_VERIFIED`.
- **Notifications** — failures suppress; never fake `SENT`.
- **Payout** — mock/unconfigured provider never disburses; owner health reads truthfully.

Proving tests: `provider-safety.test.ts`, `provider-safety.prod.test.ts`.

---

## 7. Financial integrity (Phase 9)

The money invariants are enumerated in `FINANCIAL_INVARIANTS.md` and pinned by tests: 90/10
**round-half-even** split (`traderShare + firmShare == gross`, firm absorbs remainder, whole-µ$ only),
single full-gross debit at APPROVED with a unique `(request, entry_type)` ledger key (double-debit
structurally impossible), cycle-count-once, 5-PAID completion, lost-ack → no blind re-pay, CORE 50K
trace reconciles to $0.00.

Proving tests: `financial-invariants.test.ts` (23), `payout-core.test.ts`, `payout-operations.test.ts`,
`golden-path.core50k.test.ts`.

**Known residual:** one affiliate-ledger idempotency gap (`markPayoutPaid` without row-lock/CAS) is a
P2 in `KNOWN_ISSUES.md` (HTF-9); blast radius today is a ledger record, not cash (no real payout rail).

---

## 8. Audit chain: append-only, hash-chained, tamper-evident

Every privileged mutation records an audit row (`audit.ts` `recordAudit`); rows are hash-chained
(`prevHash` links each row to its predecessor's content hash), append-only (the DB refuses UPDATE/DELETE
on `audit_log`), serialized per-org by `pg_advisory_xact_lock`, and ordered by `(createdAt, id)` with a
**strictly monotonic `createdAt`** per chain (Phase 9 fix) so same-millisecond concurrent appends cannot
desync verify ordering. `verifyAuditChain` recomputes every content hash and link.

Confirmed: **no direct `audit_log` insert exists anywhere** in source or tests — every write goes
through `recordAudit` (50 call sites).

Proving test (Phase 10): `audit-chain-stress.test.ts` — a **fresh isolated org**, 3000 events written
sequentially + in 50-wide bursts + a 100-wide concurrent burst, whole-chain `verifyAuditChain` returns
`ok:true`, `checked === total`, `brokenAt === null`. This proves integrity holds for a long-running,
concurrently-written production organization.

---

## 9. Secret handling (Phase 10 scan — PRESENT / NOT PRESENT only)

| Check | Result |
|---|---|
| `.env` / real-secret files tracked in git | **NOT PRESENT** (only `apps/server/.env.example`, placeholders; `.env` gitignored) |
| Non-empty `RITHMIC_PASSWORD` ever committed (any history, any branch) | **NOT PRESENT** |
| Rithmic credentials in client bundle / API responses / logs | **NOT PRESENT** — read server-side only; owner surface shows `credentials=present`, never the value (`rithmic-config.ts` `redactedRithmicDescription`) |
| Hardcoded provider secrets (Whop/Stripe/JWT/DB) in source | **NOT PRESENT** — all from env |
| Server secret patterns in production web bundle (`apps/web/dist`) | **NOT PRESENT** — 0 hits for `JWT_SECRET`/`DATABASE_URL`/`RITHMIC_PASSWORD`/`postgres://`/`whsec_`/`sk_live`/`sk_test`; no `VITE_` secret inlined |
| Dev demo password (`seed-demo-daily-payout.ts`) | **PRESENT but DEV-ONLY** — a throwaway fixture account; the script `throw`s if `NODE_ENV==='production'`. Not a real credential. |

No production credentials were used. Rithmic credentials are absent by design and remain OWNER-MANUAL.

---

## 10. Dev / debug surfaces are gated (Phase 4 + verified Phase 10)

Every non-production surface is inert in a production build:

- **Server dev routes** — `commerce.ts:/mock`, `onboarding.ts:/dev/simulate-payment`,
  `portal.ts:/physical-orders/:id/dev/simulate-payment` are each wrapped in
  `if (env().NODE_ENV !== 'production')`, so they are **not registered** in production.
- **Web Design Lab** — `/design-lab` renders only when `designLabEnabled()` (`import.meta.env.MODE !==
  'production'`); a direct URL in a production build falls through to the normal app
  (`App.tsx`, `runtime.ts`, `runtime.test.ts`).
- **Dev seed** — `db:seed`'s development fixtures hard-fail in production.

---

## 11. HTTP hardening (defense-in-depth)

Enforced in `http/app.ts` on every response:

- **CORS** — origin **whitelist** (`CORS_ORIGIN` split, not `*` unless explicitly set); `credentials:true`;
  only `x-atlas-ms` exposed.
- **Rate limiting** — Fastify `rateLimit`, global 600/min plus tighter per-route caps (webhooks 240/min,
  dev-sim 30/min).
- **Security headers** — `nosniff`, `X-Frame-Options: DENY`, CSP `default-src 'none'; frame-ancestors
  'none'; base-uri 'none'; form-action 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy`
  (all denied), COOP/CORP `same-origin`, `X-Permitted-Cross-Domain-Policies: none`, and **HSTS in
  production only**.
- **Error shape** — uniform `{ error: { code, message, detail? } }`; a client's malformed JSON is a
  typed `400 MALFORMED_JSON`, a Zod failure is `400 VALIDATION_FAILED`, rate-limit is `429 RATE_LIMITED`;
  only genuine 5xx are `INTERNAL_ERROR` (no stack/DB leakage to the caller).
- **Webhooks** — signature-verified (HMAC / Standard Webhooks) with no session; unsigned/replayed events
  are rejected and de-duplicated before any provisioning (`commerce_events`).

Proving tests: `security.test.ts`, `authz-security.test.ts`, `ws-security.test.ts`, `replay-controls.test.ts`.

---

## 12. WebSocket

Every subscription is authenticated and ownership-checked (`mayFollowAccount`); a client cannot follow
another user's account streams. Backpressure and limits are enforced. Proving test: `ws-security.test.ts`.

---

## 13. Dependency posture (Phase 10 `pnpm audit`)

- **Production dependencies: no known vulnerabilities.**
- **One moderate dev-only advisory:** `esbuild ≤0.24.2` reachable **only** transitively via
  `drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` (a dev-server CORS issue,
  GHSA-67mh-4wv8-2f99). It is a migration/build-time tool, **never in the production runtime or the
  shipped bundle**. Accepted as DEV-ONLY; tracked in `KNOWN_ISSUES.md`. Not force-overridden to avoid
  destabilizing `drizzle-kit`'s deprecated `@esbuild-kit` chain.

---

## 14. What this model deliberately does NOT claim

- No penetration test by a third party; no formal compliance certification.
- Real payment/KYC/payout/live-market-data boundaries are **not** wired (mock/dev/unconfigured) — see
  `LAUNCH_GATES.md` G1/G2/G3/G8 and `MONEY_FLOW.md`.
- The affiliate-ledger idempotency gap (HTF-9) needs a constraint/CAS + concurrency test.
- Console surfacing of the safety mutations (HTF-10) is API-operable but not yet in the console UI.

See `THREAT_MODEL.md` for the adversary-by-adversary analysis and `KNOWN_ISSUES.md` for the live gap list.
