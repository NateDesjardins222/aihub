# Atlas — Security & Production Hardening V1 — closure report

Branch `claude/futures-trading-simulator-v8qefu`. Locked verified baseline at
milestone start: `77fb204`. This milestone treated Atlas as if it were about to
be exposed on the public internet: it **attacked the platform**, fixed what was
**provably** broken, documented what was found sound or accepted, and locked the
result with adversarial tests — without destabilising the locked reliability
spine (execution, account authority, mutex/transactions, projection read model,
commercial lifecycle, audit, outbox, owner reads).

> This is a hardening pass, not a certification. Atlas is **not** claimed to be
> "unhackable", PCI-compliant, SOC 2-compliant, production-certified, or legally
> compliant. The language below is deliberately precise and severities reflect
> *actual* impact.

## Money / integration posture (explicit, unchanged)

- REAL MONEY ENABLED: **NO**
- AUTHENTICATED WHOP SANDBOX: **PAUSED / NOT VALIDATED**
- PRODUCTION WHOP: **NOT ENABLED**
- REAL PAYOUTS: **NOT IMPLEMENTED**
- REAL BROKERAGE: **NOT IMPLEMENTED**
- AUTHENTICATED DATABENTO: **PAUSED**
- PROFESSIONAL LIVE MARKET DATA: **NOT ENABLED**

No Whop or Databento credentials were requested, pasted, or used. All work was
offline. No discovered secret value is printed anywhere in this milestone's
output.

## What was attacked

The full externally reachable surface, mapped in
`security-production-hardening-v1-plan.md`: unauthenticated HTTP (auth endpoints,
health, webhook, instruments), authenticated trader HTTP (accounts, orders,
journal, checkout), operator HTTP (`/admin/*`), and the WebSocket gateway.
Dimensions: authentication, session management, RBAC, tenant isolation, IDOR,
mass assignment, injection (SQL / prototype pollution), CORS, security headers,
rate limiting, resource exhaustion, secret handling, log/error leakage,
production config, and dependency/build posture.

## Defects found and fixed (all offline-provable)

| ID | Sev | Defect | Fix | Proof |
| --- | --- | --- | --- | --- |
| F-01 | **P1** | Auth endpoints had no rate limit (global limiter is `global:false`) → brute-force / stuffing / enumeration amplification unbounded | Per-route IP-keyed limits: login 20/min, refresh 30/min, register 10/min, logout 30/min | `security.test.ts`: login trips 429 under burst |
| F-02 | **P2** | `trustProxy:true` unconditional → client spoofs `X-Forwarded-For`, controls `request.ip`, mints a fresh rate-limit bucket per request | `trustProxy` off by default, gated on `TRUSTED_PROXY` env | `security.test.ts`: rotating `X-Forwarded-For` still trips the limit |
| F-03 | **P2** | No HTTP security headers | `onSend` hook: nosniff, frame denial, strict CSP, Referrer-Policy, Permissions-Policy, COOP/CORP; HSTS in production | `security.test.ts`: headers present, HSTS withheld outside prod |
| F-04 | **P2** | WebSocket: no `maxPayload`, no message-rate limit, no send backpressure → memory/CPU/DB exhaustion levers | `maxPayload` 64 KiB; per-socket token bucket (close on sustained flood); drop on `bufferedAmount` > 4 MiB | `ws-security.test.ts`: oversize frame closes; flood → RATE_LIMITED + 4429 close; backpressure predicate |
| F-05 | **P3** | Web build always shipped source maps | Off by default; `WEB_SOURCEMAP=true` opt-in | verified: default `vite build` emits no `.map` |

## Accepted / documented limitations (not fixed — with rationale)

| ID | Sev | Limitation | Why accepted |
| --- | --- | --- | --- |
| F-06 | P3 | `requireUser` trusts access-token claims → a disabled/role-revoked user keeps trader-level access ≤ 15 min on requireUser-only routes | `requireRole` re-reads the DB (privileged routes safe); refresh blocked immediately; short TTL. A per-request DB read on every trader call would tax the spine; a token deny-list is the documented future path |
| F-07 | P3 | `register` returns `EMAIL_TAKEN` — an account-existence oracle | login is timing-equalized and generic; kept for sign-up UX; bulk enumeration now bounded by the F-01 rate limit |

Both are recorded in `security-failure-ledger.md` (append-only; nothing deleted).

## Attacked and found sound (no change)

Password hashing (scrypt N=32768,r=8,p=1, NFKC, constant-time); refresh rotation
(atomic single-use, reuse-safe, disabled-user blocked); login timing
equalization; RBAC (rank-based, DB-backed, status-gated); IDOR
(`assertOwnership`/`mayFollowAccount` fail closed with a 404, no oracle); tenant
isolation (org-scoped, no existence oracle); injection (Zod validation + Drizzle
parameterization; no `...body` mass assignment; no prototype-pollution sink);
production config guard (refuses the default `JWT_SECRET` and `*` CORS in prod,
exit 78); seed gating (`NODE_ENV !== 'production'`); no committed secrets;
secrets never returned; log redaction; error handling (no stack leak, correct
statuses, malformed JSON → 400); webhook (Standard Webhooks HMAC, refuses
unsigned, inert without a secret).

## Verification (real numbers, this environment)

| Check | Result |
| --- | --- |
| Full suite (`pnpm -s test`, isolate mode) | **888/888 passed, 62 files** (873 baseline + 15 security) |
| New security tests | `security.test.ts` 6, `ws-security.test.ts` 4, `authz-security.test.ts` 5 |
| Typecheck (all workspaces) | clean |
| Web build | clean; **no source maps emitted** by default |
| `security:fuzz` | **6193 checks, 0 failures** |
| `security:torture` | 50,000 rounds in ~1.6s, **0 throws**; malformed password hashes rejected; backpressure correct |
| Commercial lifecycle / Whop / payment-offline regressions | included in the full suite, all green (no regression) |

## Deliverables

- `docs/security-production-hardening-v1-plan.md` — attack-surface map + threat model.
- `docs/security-role-matrix.md` — server-enforced RBAC / ownership / tenant matrix.
- `docs/security-failure-ledger.md` — append-only findings ledger (F-01…F-07).
- `docs/production-environment-reference.md` — every env var, secret inventory, preflight checklist (no real values).
- `docs/production-backup-restore-requirements.md` — PostgreSQL backup/restore requirements and validated restore procedure.
- `docs/security-production-hardening-v1-report.md` — this report.
- `scripts/fuzz-security.ts`, `scripts/torture-security.ts` — pure adversarial harnesses (`security:fuzz`, `security:torture`).
- Code fixes: `apps/server/src/config/env.ts`, `apps/server/src/http/app.ts`,
  `apps/server/src/http/routes/auth.ts`, `apps/server/src/ws/gateway.ts`,
  `apps/web/vite.config.ts`; tests `security.test.ts`, `authz-security.test.ts`,
  `ws-security.test.ts`.

## Not started (out of scope by instruction)

Whop authentication / production payments / payouts, Databento authentication /
professional live market data, deployment / cloud-provider selection, new
products / account rules / chart features. Payments and market-data providers
remain paused.

## Residual risk (honest close)

The fixes close the concrete, provable levers found on the reachable surface.
Residual, documented items: the ≤15-min token-revocation window (F-06) and the
registration enumeration oracle (F-07), both bounded. This pass hardened the
edge and proved the core sound; it did not, and does not claim to, make Atlas
invulnerable. Continued hardening (a token deny-list, dependency-audit
automation in CI, and a full authenticated penetration test before any real-money
enablement) is the natural next step when those milestones resume.
