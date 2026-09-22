# Atlas — security failure ledger

Append-only. **Embarrassing findings are not deleted.** Each entry records what
was wrong (or feared wrong), how it was proven, the fix, and the proof it is
fixed. Severity is by *actual* impact (P0 = exploitable now with real
consequence; P1 = serious, likely; P2 = real weakness, bounded; P3 = minor /
defense-in-depth). No claim of "unhackable", PCI/SOC2/production-certified, or
legal compliance is made anywhere.

Baseline `77fb204`. Milestone: Security & Production Hardening V1.

---

## F-01 — Auth endpoints had no rate limit — **P1** — FIXED

**Found.** The global rate limiter is registered with `global: false`, and
`/api/v1/auth/register`, `/login`, `/refresh`, `/logout` carried no per-route
`config.rateLimit`. Result: unlimited attempts. Credential stuffing, password
brute-force, refresh-token guessing, and account-enumeration amplification were
all wide open — the single most impactful public-internet weakness.

**Proven.** Read of `app.ts` (limiter `global:false`) + `routes/auth.ts` (no
route config). Adversarial test hammers `/login` and asserts unbounded attempts
were possible before the fix / are 429-capped after.

**Fixed.** Per-route IP-keyed `config.rateLimit` on all four auth routes
(login/refresh strict, register moderate, logout moderate). Depends on F-02 so
the IP key is trustworthy.

**Proof of fix.** `apps/server/src/http/security.test.ts` — login/refresh return
429 after the configured burst; a genuine login still succeeds within budget.

---

## F-02 — Unconditional `trustProxy` let clients spoof their IP — **P2** — FIXED

**Found.** `Fastify({ trustProxy: true })` was unconditional. With no proxy in
front (or a direct connection bypassing one), any client can send
`X-Forwarded-For: <anything>` and Fastify reports it as `request.ip`. That IP is
the rate-limit key and any IP we log/attribute — so an attacker rotates a
spoofed IP per request and the F-01 limit (and any IP-based audit) is defeated.

**Proven.** Read of `app.ts`. Adversarial test sends many requests with rotating
`X-Forwarded-For` and asserts the limit still trips (the header is ignored) once
trust is off.

**Fixed.** `trustProxy` gated on a new `TRUSTED_PROXY` env (default off → do not
trust the header). An operator who really is behind a known proxy sets it.

**Proof of fix.** `security.test.ts` — rotating `X-Forwarded-For` does not raise
the effective rate-limit budget (default config); documented in the env
reference.

---

## F-03 — No HTTP security response headers — **P2** — FIXED

**Found.** Responses carried none of: `X-Content-Type-Options: nosniff`,
`X-Frame-Options`/frame denial, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy`/`-Resource-Policy`, `Content-Security-Policy`, or
`Strict-Transport-Security` (prod). Defense-in-depth against MIME sniffing,
clickjacking/embedding, referrer leakage, and downgrade.

**Proven.** Header inspection of `/health` and API responses (none present).

**Fixed.** Dependency-free `onSend` hook sets a conservative header set on every
response; HSTS added only when `NODE_ENV=production`. A strict CSP suitable for a
JSON API (`default-src 'none'; frame-ancestors 'none'`) is applied to API
responses.

**Proof of fix.** `security.test.ts` — asserts each header on a real response,
and that HSTS is present only in production mode.

---

## F-04 — WebSocket had no frame-size / rate / backpressure limits — **P2** — FIXED

**Found.** `new WebSocketServer({ noServer: true })` with no `maxPayload` →
~100 MiB default frame (one client → memory exhaustion). No per-connection
message-rate limit → a frame flood drives DB queries (`mayFollowAccount`) and
snapshot builds (CPU/DB exhaustion). `raw()` calls `socket.send()` without
checking `socket.bufferedAmount` → a slow consumer subscribed to fast streams
buffers unboundedly server-side (memory exhaustion).

**Proven.** Read of `ws/gateway.ts`. Adversarial test opens a socket, sends an
oversize frame (rejected/closed), floods control frames (throttled), and
simulates backpressure (dropped).

**Fixed.** `maxPayload: 64 KiB`; token-bucket message-rate limit per client
(excess → `RATE_LIMITED` error frame, sustained abuse → close); disconnect when
`bufferedAmount` exceeds a cap.

**Proof of fix.** `apps/server/src/ws/ws-security.test.ts`.

---

## F-05 — Web build always shipped source maps — **P3** — FIXED

**Found.** `vite.config.ts` had `build.sourcemap: true` unconditionally, so a
production deploy ships `.map` files exposing the full unminified frontend
source.

**Proven.** Read of `apps/web/vite.config.ts`.

**Fixed.** Source maps off by default; opt-in via `WEB_SOURCEMAP=true` for
profiling (`vite preview`). Documented in the env reference.

**Proof of fix.** Config reads the env; default build emits no maps.

---

## F-06 — Access-token claims trusted for ≤15 min after disable — **P3** — ACCEPTED (documented)

**Found.** `requireUser` trusts the access-token claims. A user disabled or
role-revoked mid-session keeps trader-level access on `requireUser`-only routes
until the token expires (`ACCESS_TOKEN_TTL_SECONDS` = 15 min).

**Assessment.** Bounded and low. Every *privileged* route uses `requireRole`,
which re-reads role+status from the DB, so operator capabilities are revoked
immediately; refresh is blocked immediately for a disabled user; the residual
window is 15 min of *own-account* trader access.

**Decision.** Accepted, not fixed this milestone. A per-request DB read on every
trader call would tax the reliability spine; the documented future path is a
short-lived token deny-list or a lower TTL. Recorded in the role matrix.

---

## F-07 — `register` returns an account-existence oracle — **P3** — ACCEPTED (documented)

**Found.** `register` returns `EMAIL_TAKEN` (409), revealing whether an address
is registered. (`login` is timing-equalized and returns a generic error, so it
is not an oracle.)

**Assessment.** Low. Kept for sign-up UX; bulk enumeration is now bounded by the
F-01 rate limit on `/register`.

**Decision.** Accepted, not fixed. Documented here and in the plan.

---

## Verified-solid (attacked, found sound — no change)

Password hashing (scrypt, constant-time, NFKC); refresh rotation (atomic,
single-use, reuse-safe); login timing equalization; RBAC (rank, DB-backed,
status-gated); IDOR (`assertOwnership`/`mayFollowAccount`, fail-closed 404);
tenant isolation (org-scoped, no oracle); injection (Zod + Drizzle
parameterization, no mass assignment, no prototype-pollution sink); production
config guard (default secret / wildcard CORS refused, exit 78); seed gating
(`NODE_ENV !== 'production'`); no committed secrets; secrets never in responses;
log redaction; error handling (no stack leak, correct statuses); webhook
(Standard Webhooks HMAC, refuses unsigned, inert without secret).
