# Atlas — Security & Production Hardening V1 — plan & attack-surface map

Branch `claude/futures-trading-simulator-v8qefu`. Locked verified baseline
`77fb204`. This is an **adversarial** milestone: treat Atlas as if it is about
to be exposed on the public internet, attack the platform, and fix only what is
**provably** broken — wrapping and strengthening the locked reliability spine
(execution, account authority, mutex/transactions, projection read model,
commercial lifecycle, audit, outbox, owner reads), never rewriting mature
architecture without a demonstrated defect.

> **Golden rule.** "Tests pass" ≠ "system is secure." Every claim below is
> either backed by a written adversarial test or explicitly marked as an
> accepted, documented limitation. No severity is inflated; no embarrassing
> finding is deleted (see `security-failure-ledger.md`).

## Money / integration posture (unchanged, restated)

- REAL MONEY ENABLED: **NO**
- AUTHENTICATED WHOP SANDBOX: **PAUSED / NOT VALIDATED**
- PRODUCTION WHOP: **NOT ENABLED**
- REAL PAYOUTS: **NOT IMPLEMENTED**
- REAL BROKERAGE: **NOT IMPLEMENTED**
- AUTHENTICATED DATABENTO: **PAUSED**
- PROFESSIONAL LIVE MARKET DATA: **NOT ENABLED**

No Whop or Databento credentials are requested, pasted, or used in this
milestone. All work is offline.

## Externally reachable attack surface

Every surface below is mapped for: **authn** (is a valid session required),
**authz** (what role/ownership), **org boundary** (tenant scoping), **input
boundary** (validation), **mutation** (what it can change), **rate limit**,
**sensitive-data exposure**, **failure behaviour**.

### HTTP — unauthenticated

| Surface | authn | authz | input | mutation | rate limit (baseline) | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /health` | none | none | none | none | none | returns `{status,time,env}` — no secrets |
| `POST /api/v1/auth/register` | none | none | Zod | creates user + practice acct | **NONE ← F-01** | `EMAIL_TAKEN` oracle (F-07) |
| `POST /api/v1/auth/login` | none | none | Zod | issues tokens | **NONE ← F-01** | timing-equalized, generic error |
| `POST /api/v1/auth/refresh` | refresh token | token owner | Zod | rotates tokens | **NONE ← F-01** | atomic single-use rotation |
| `POST /api/v1/auth/logout` | refresh token | token owner | Zod | revokes token | **NONE ← F-01** | idempotent |
| `POST /api/v1/webhooks/whop` | HMAC signature | provider | raw body + sig | fulfils orders | 60/min (route) | Standard Webhooks; refuses unsigned; inert without secret |
| `GET /api/v1/instruments/*` | none | none | none | none | global 600/min off → **none** | static registry, no secrets |

### HTTP — authenticated (trader)

| Surface | authn | authz | org | input | mutation | rate limit |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/v1/auth/me` | access token | self | — | — | reads own user | none (read) |
| `/api/v1/accounts/*` | access token | `accounts.userId == caller` | via user | Zod/params | account reads | none (read) |
| `/api/v1/orders`, `/positions`, `/brackets`, … | access token | `assertOwnership` (404 fail-closed) | via user | Zod | places/modifies orders | 120/min (route) |
| `/api/v1/journal/*` | access token | self | via user | Zod | journal CRUD | none |
| `/api/v1/marketdata/*` | access token | self | — | Zod | none (reads) | none |
| `/api/v1/checkout/*` | access token | self | via user | Zod | creates PENDING order | 30/min (route) |
| `/api/v1/provisioning/*` | access token | self / server | via user | Zod | provisions | 60/min (route) |

### HTTP — authenticated (operator)

| Surface | authn | authz | org | rate limit |
| --- | --- | --- | --- | --- |
| `GET /api/v1/admin/*` (reads) | access token | `requireRole(SUPPORT)` DB-backed | `organizationOf(caller)` | 60–120/min (route) |
| `POST /api/v1/admin/*` (mutations) | access token | `requireRole(ADMIN\|SUPER_ADMIN)` DB-backed | org-scoped | 20–60/min (route) |

### WebSocket — `/ws`

| Aspect | state |
| --- | --- |
| authn | `hello` frame → `verifyAccessToken`; unauthenticated socket cannot subscribe |
| authz | account streams gated by `mayFollowAccount` (ownership; 404-equivalent forbid) |
| subscription cap | `MAX_SUBSCRIPTIONS = 64` per socket |
| idle timeout | 45 s, heartbeat 5 s |
| **frame size** | **unbounded (~100 MiB default) ← F-04** |
| **message rate** | **unbounded ← F-04** |
| **send backpressure** | **none (no `bufferedAmount` check) ← F-04** |

## Confirmed defects (to fix this milestone — all offline-provable)

| ID | Sev | Defect | Fix |
| --- | --- | --- | --- |
| F-01 | **P1** | Auth endpoints (`register`/`login`/`refresh`/`logout`) have no rate limit; global limiter is `global:false`. Brute-force, credential stuffing, refresh-guessing, and enumeration amplification are unbounded. | Per-route IP-keyed `config.rateLimit` (login/refresh strict, register moderate). |
| F-02 | **P2** | `trustProxy: true` is unconditional, so a direct client can set `X-Forwarded-For` and control `request.ip` — defeating IP rate limits and poisoning IP attribution. | Gate on `TRUSTED_PROXY` env (default off / no trust). |
| F-03 | **P2** | No HTTP security response headers (nosniff, frame denial, Referrer-Policy, Permissions-Policy, COOP/CORP, HSTS in prod). | Dependency-free `onSend` header hook; HSTS only in production. |
| F-04 | **P2** | WebSocket: no `maxPayload`, no per-connection message-rate limit, no send backpressure. Single client can exhaust memory/CPU/DB. | `maxPayload` 64 KiB; token-bucket message limit; disconnect on excessive `bufferedAmount`. |
| F-05 | **P3** | Web production build always emits source maps, shipping full frontend source. | Off by default; opt-in via `WEB_SOURCEMAP=true` for profiling. |

## Accepted / documented limitations (not fixed — with rationale)

| ID | Sev | Limitation | Why accepted |
| --- | --- | --- | --- |
| F-06 | P3 | `requireUser` trusts access-token claims, so a disabled/role-revoked user keeps access ≤ `ACCESS_TOKEN_TTL_SECONDS` (15 min) on requireUser-only routes. | `requireRole` re-reads the DB (all privileged routes safe); refresh is blocked immediately; TTL is short. A per-request DB read on every trader call would tax the spine; a token deny-list is the documented future path. |
| F-07 | P3 | `register` returns `EMAIL_TAKEN` (409) — an account-existence oracle. | Login is timing-equalized and generic; register is kept explicit for sign-up UX. Bulk enumeration is now bounded by the F-01 rate limit. |

## Verified already-solid (no change — confirmed by reading + existing tests)

- **Password hashing** — `scrypt` (N=32768,r=8,p=1), NFKC-normalized, constant-time compare.
- **Refresh rotation** — atomic single-use (`UPDATE … WHERE revokedAt IS NULL RETURNING`), reuse-safe, disabled-user blocked.
- **Login** — timing-equalized (placeholder hash when no row), generic `INVALID_CREDENTIALS`.
- **RBAC** — rank-based, DB-backed on every privileged route, blocks non-`ACTIVE`.
- **IDOR** — `assertOwnership` fails closed (404, no existence oracle) on every trader account route; WS `mayFollowAccount` enforces ownership.
- **Tenant isolation** — org-scoped reads throughout owner console (proven in `owner-isolation.test.ts`).
- **Injection** — Zod-validated bodies; Drizzle parameterization (no string SQL); no `...request.body` mass assignment; no prototype-pollution sink into the DB.
- **Production config guard** — refuses default `JWT_SECRET` and wildcard `CORS_ORIGIN` in production (exit 78).
- **Seeds** — demo/owner accounts gated by `NODE_ENV !== 'production'`.
- **Secrets** — none committed (git-clean); never returned in any response; logs redact `authorization`, `password`, `refreshToken`.
- **Error handling** — no stack leak; framework status preserved; malformed JSON → 400 not 500.
- **Webhook** — Standard Webhooks HMAC-SHA256; refuses unsigned; inert without secret.

## Execution plan (phases)

1. **Autopsy & docs** (this doc, `security-role-matrix.md`, `security-failure-ledger.md`). ✔
2. **F-01** auth rate limiting + adversarial tests (brute-force is bounded; refresh reuse/revocation re-proven).
3. **F-02/F-03** HTTP hardening — proxy-trust gate, security headers + tests (spoofed `X-Forwarded-For` ignored; headers present; CORS fail-closed).
4. **F-04** WebSocket limits + backpressure + tests (oversize frame rejected; flood throttled; slow consumer dropped; revocation behaviour documented).
5. **F-05** source-map gate + env reference.
6. **Adversarial harnesses** — `scripts/fuzz-security.ts`, `scripts/torture-security.ts`.
7. **Full regression** (`pnpm -s test`), typecheck, web build; **report**, **failure ledger**, **backup/restore requirements**, **environment reference**; commit, push, verify remote==local, STOP.

Each fix is minimal, wraps the spine, and lands with its own test before the next.
