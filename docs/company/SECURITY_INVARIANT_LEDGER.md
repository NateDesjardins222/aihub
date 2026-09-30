# Security Invariant Ledger

**Security Phase 1** — the security properties the platform holds, each mapped to
the proving test(s). Verified by re-attack at commit `ae9a4a3` (baseline security
suites: 166/166 green). This is the security counterpart to
`BACKEND_INVARIANT_LEDGER.md`.

| # | Invariant | Enforcement | Proving test(s) |
|---|---|---|---|
| SI-1 | An unauthenticated principal cannot access protected customer state | per-route `requireUser` (401) | `security.test.ts`, `authz-security.test.ts`, `trading-authz-http.test.ts` |
| SI-2 | A customer can access only account resources they own; a foreign id is 404 with no existence oracle | handler ownership checks (`accounts.userId == caller`) | `m10-1-rbac-redteam.test.ts`, `authz-security.test.ts`, `certificate-security.routes.test.ts` |
| SI-3 | A customer cannot invoke an owner/staff mutation (URL, direct API, forged role) | `requireRole`/`requirePermission` re-read from DB; token role not trusted | `owner-authz-http.test.ts`, `m10-1-rbac-redteam.test.ts`, `staff-rbac-adversarial.test.ts` |
| SI-4 | A trader cannot submit/flatten/trade on another identity's account (real HTTP order path) | account-ownership gate before execution | `trading-authz-http.test.ts` |
| SI-5 | A client cannot set authoritative money (balance, gross, split, paidCycles) | Zod-explicit bodies; server computes money; no pass-through | `authz-security.test.ts` (mass-assignment), `financial-invariants.test.ts`, `payout-operations.test.ts` |
| SI-6 | A client cannot set authoritative role/ownership/lifecycle via the body | Zod shapes omit `userId/organizationId/role/status`; re-read from DB | `authz-security.test.ts` ("registration cannot smuggle a privileged role") |
| SI-7 | A foreign nested resource cannot be mutated through an owned parent id | ownership follows authoritative parent relationship | `m10-1-rbac-redteam.test.ts`, `payouts.routes.test.ts`, `copy.routes.test.ts` |
| SI-8 | An invalid webhook (missing/wrong/modified signature, bad timestamp) produces no business effect | Standard-Webhooks HMAC verify-before-effect over raw body | `security.test.ts`, `commerce-whop.test.ts`, `replay-controls.test.ts` |
| SI-9 | A duplicate webhook cannot duplicate a business effect | `commerce_events` / `payout_provider_events` unique `(provider, event_id)` | `replay-controls.test.ts`, `payout-operations.test.ts` |
| SI-10 | A server-only secret never appears in the browser bundle or an API response | env-only secrets; bundle scan; logger redaction | `security.test.ts` (no-secret-in-response), bundle scan (`SECURITY_MODEL.md` §9) |
| SI-11 | Logout revokes the refresh token immediately (server-side) | `logout()` sets `revokedAt`; refresh replay rejected | `security.test.ts` (logout/refresh) |
| SI-12 | A disabled/revoked identity is denied even with a cryptographically valid token | `requireRole` re-reads `status`; refresh re-checks ACTIVE | `authz-security.test.ts` |
| SI-13 | A security-dependency failure does not grant access (fail closed) | guards throw on lookup failure; no fail-open path | `enforcement-authz.test.ts`, `authz-security.test.ts` |
| SI-14 | Login is not an enumeration oracle and is rate-limited; a spoofed XFF cannot escape it | dummy-hash verify on unknown user; per-IP limit; `trustProxy` off | `security.test.ts`, `authz-security.test.ts` |
| SI-15 | High-risk owner money/staff/kill-switch actions require server-enforced step-up | `requireReauth(class)` demands fresh `x-stepup-token` | `owner-authz-http.test.ts`, `owner-staff-http.test.ts`, `owner-config-http.test.ts` |
| SI-16 | The step-up password gate itself resists online brute force | rate-limit 10/min per IP on `/admin/security/reauth` (**SEC-1 fix**) | `security-phase1.test.ts` |
| SI-17 | Kill switches actually block their money/lifecycle chokepoints (HTTP 423) | `assertNotEngaged` at each chokepoint | `kill-switch-enforcement.test.ts` |
| SI-18 | A trader cannot weaken the rules they are judged by on a commercial account | `assertSelfServeMutable` → 403 unless PRACTICE | `self-serve-boundary.test.ts` |
| SI-19 | A customer cannot copy-trade into/among accounts they do not own | own-account fanout guard | `copy.routes.test.ts`, `affiliate-security.test.ts` (analogous) |
| SI-20 | WebSocket subscriptions are authenticated and ownership-checked; no cross-user event leakage | `mayFollowAccount` | `ws-security.test.ts` |
| SI-21 | No externally-reachable SQL/command/path/SSRF/redirect/XSS/prototype-pollution sink | parameterized Drizzle, no `child_process` in request path, confined storage keys, fixed provider URLs, React escaping | injection audit (Phase 1) + code review |
| SI-22 | The audit chain is append-only and tamper-evident under concurrency | hash-chain, DB refuses UPDATE/DELETE, per-org advisory lock | `audit-chain-stress.test.ts` |
| SI-23 | Provider integrations fail closed in production (no mock money/KYC/payout) | `config/provider-safety.ts` | `provider-safety.test.ts`, `provider-safety.prod.test.ts` |
| SI-24 | Production refuses to boot on an insecure `JWT_SECRET` or wildcard CORS | `config/env.ts` boot guards | `env` config tests |

## Gaps / non-invariants (honestly stated)

- **Access-token revocation is not immediate** — a stateless JWT stays valid until
  its ≤15-min `exp` after logout / `revokeAllSessions`; only refresh tokens are
  killed server-side. Documented tradeoff, tracked (P3).
- **Payout webhook signature (SEC-3)** — not verified today (seam); production fails
  closed to a no-op. Pre-launch gate before a real payout rail.
- **Market-data replay/provider (SEC-2)** — global singleton reachable by any
  customer; cross-tenant chart-feed effect (no money/authz/private-data). Per-session
  isolation is an Atlas redesign (out of scope).
