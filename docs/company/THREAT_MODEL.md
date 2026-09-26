# THREAT MODEL

**Happy Trader Funding — adversary-by-adversary analysis of what could go wrong and what stops it.**

Phase 10 (2026-09-26) — security + adversarial hardening. Companion to `SECURITY_MODEL.md` (the
boundaries) and `KNOWN_ISSUES.md` (the live gap list). Baseline HEAD at phase entry: `5072596`.

> **Honesty & scope.** Deterministic/adversarial tests and dev/sandbox fixtures only. No real money,
> real rails, or production/live Rithmic. No third-party pentest is claimed. Residual risks are stated
> plainly, not hidden.

## Assets worth protecting

1. **Money integrity** — simulated balances, payout ledger, affiliate ledger, commerce records. (No real
   cash moves today, but the ledgers must be exactly-once and conserved for when a rail is wired.)
2. **Evaluation fairness** — the risk rules a trader is judged by, and the pass/fund decision.
3. **Tenant data** — one customer's accounts, orders, identity, support, and enforcement records must not
   leak to another.
4. **Operator authority** — only staff of the right rank may fund, hold, adjust, or reconfigure.
5. **Audit truth** — the tamper-evident record of who did what.
6. **Secrets** — provider credentials, JWT secret, DB URL, Rithmic credentials.

## Trust boundaries

`Browser (untrusted)` → `HTTP/WS API (authN + authZ + validation)` → `Domain services (server authority)`
→ `PostgreSQL (locks + constraints + append-only audit)`. External providers (Whop, Stripe, Rithmic,
Resend, Twilio) sit behind fail-closed selectors. Webhooks cross the boundary inbound and are
signature-verified before any state change.

---

## Adversary 1 — Malicious trader (authenticated customer)

| Goal | Attack | Defense | Evidence |
|---|---|---|---|
| Fake profit / balance | assert P&L or balance from the client | server is sole writer; client can only request | engine authority; trading tests |
| Weaken own risk rules | `PUT /accounts/:id/rules` on an eval/funded account | `assertSelfServeMutable` → 403 `SELF_SERVE_FORBIDDEN`, override never persisted | `self-serve-boundary.test.ts` |
| Revive a breached account | `POST /accounts/:id/reset` | same gate → 403 on commercial accounts | `self-serve-boundary.test.ts` |
| Turn off own fees/environment | `PUT /accounts/:id/environment` | same gate → 403 | `self-serve-boundary.test.ts` |
| Read another customer's data | IDOR on account/order/payout/support ids | `self` scope → 404 no existence oracle | `m10-1-rbac-redteam.test.ts`, `golden-path.security.test.ts` |
| Escalate to operator | call `/admin/*` with a trader token | `requireRole(SUPPORT+)` → 403 | `owner-authz-http.test.ts` |
| Mass-assignment | inject `role`/`status`/`userId`/`organizationId` in a body | Zod explicit shapes; no client-trusted identity | authz suites |
| Provision without paying | POST a fake "payment success" | provisioning only from a server-verified provider event; dev-sim route is non-prod + owner-scoped | `commerce`/`onboarding` route tests |
| Double payout | race `requestPayout`/`approvePayout` | advisory lock + `FOR UPDATE` + version CAS + unique `(request, entry_type)` | `payout-operations.test.ts`, `financial-invariants.test.ts` |

**Residual:** none known for the trader surface beyond the affiliate-ledger gap (Adversary 6).

---

## Adversary 2 — Cross-tenant attacker (Customer A vs Customer B)

Every trader-scoped read/write filters on `accounts.userId == caller`; every owner-scoped one on
`organizationOf(caller)`. A foreign id returns **404 with no existence oracle** (no 403-vs-404 timing/shape
leak). Verified across accounts, orders, journal, payouts, certificates, enforcement, support, affiliate.
Evidence: `m10-1-rbac-redteam.test.ts`, `enforcement-authz.test.ts`, `affiliate-security.test.ts`,
`golden-path.security.test.ts`.

**Residual:** none known.

---

## Adversary 3 — Low-privilege operator (SUPPORT/ADMIN abusing rank)

Rank-ordered RBAC; `requireRole` **re-reads role + status from the DB** each call, so a demoted or
disabled operator is denied even with a still-valid token. SUPPORT cannot fund, hold, adjust, redact, or
reconfigure; ADMIN cannot change product config (SUPER_ADMIN only). Four-eyes on sensitive enforcement
actions (M7). Every privileged mutation is audited with a required reason. Evidence: `rbac.test.ts`,
`rbac-permissions.test.ts`, `owner-authz-http.test.ts`, capability matrix in `security-role-matrix.md`.

**Residual:** a compromised SUPER_ADMIN is in-scope by design (root of the org); mitigations are audit
trail + four-eyes + kill switches, not prevention.

---

## Adversary 4 — Unauthenticated internet attacker

| Attack | Defense |
|---|---|
| Credential stuffing / brute force | per-route rate limits; no user enumeration; argon2/bcrypt |
| Forged webhook → free provisioning | HMAC/Standard-Webhooks signature required; unsigned rejected; `commerce_events` dedup before provisioning |
| Replay a captured webhook | idempotency + event dedup; `replay-controls.test.ts` |
| Clickjacking / framing | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` |
| MIME sniffing / XSS via API | `nosniff`; CSP `default-src 'none'`; JSON-only API |
| Info leak via errors | uniform typed error shape; no stack/DB detail to caller |
| Reach a dev/mock endpoint in prod | dev routes not registered when `NODE_ENV==='production'`; Design Lab inert in prod build |
| Steal secrets from the bundle | 0 server secrets in `apps/web/dist` (Phase 10 scan) |

Evidence: `security.test.ts`, `authz-security.test.ts`, `replay-controls.test.ts`, bundle scan.

**Residual:** DoS/volumetric resilience is bounded by app-level rate limits only; edge/WAF and infra DDoS
protection are deployment concerns (Phase 11/G12), not in this repo.

---

## Adversary 5 — Misconfigured production (the operator's own mistake)

The highest-value historical risk: launching without wiring real providers and silently mocking money.
Phase 4 made this **impossible in code** — commerce and identity fail closed in production
(`MOCK_COMMERCE_FORBIDDEN`, throwing identity seam), notifications suppress rather than fake, payout mock
never disburses. A production boot without providers returns honest "unconfigured" seams and 503s, never a
fabricated success. Evidence: `provider-safety.prod.test.ts`.

**Residual:** the operator must still set `JWT_SECRET`, `DATABASE_URL`, `CORS_ORIGIN` correctly; env
validation (`config/env.ts`) rejects a too-short JWT secret at boot.

---

## Adversary 6 — Concurrency / race exploiter

Money and lifecycle transitions are serialized: trader payout (advisory lock + `FOR UPDATE` + version CAS
+ unique ledger key), commerce webhooks (dedup), provisioning (idempotency keys + request-hash guard),
certificates/achievements (unique dedupe key), audit (per-org advisory lock + monotonic `createdAt`).
A 100-wide concurrent audit burst on one chain never forks or breaks linkage
(`audit-chain-stress.test.ts`).

**Residual (known, tracked HTF-9):** `affiliate-payouts.ts markPayoutPaid` selects without `FOR UPDATE`
and lacks a unique `(payoutId, entryType)` constraint — two concurrent calls could theoretically
double-insert a `PAYOUT_PAID` entry. Blast radius today is a ledger record, not cash (no real affiliate
payout rail). Fix = DB constraint or row-lock/CAS + concurrency test, before any real affiliate rail.

---

## Adversary 7 — Insider tampering with the audit record

`audit_log` is append-only (DB refuses UPDATE/DELETE), hash-chained (each row links its predecessor's
content hash), and verifiable (`verifyAuditChain` recomputes every hash + link). No direct insert path
exists anywhere — all 50 write sites go through `recordAudit`. Any edit or deletion breaks the chain and
is detected. Evidence: `audit-chain-stress.test.ts` + the no-direct-insert grep (Phase 10 PART 37).

**Residual:** a full-DB restore to an earlier snapshot could roll back the chain wholesale; detection
there depends on external backup/attestation (Phase 11/G12).

---

## Adversary 8 — Supply chain / dependencies

`pnpm audit`: production deps clean; one **moderate dev-only** advisory (esbuild ≤0.24.2 via
`drizzle-kit`'s transitive `@esbuild-kit` chain — dev-server CORS, never in the runtime or bundle).
Accepted DEV-ONLY, tracked in `KNOWN_ISSUES.md`. Per policy, no attack was run against any external
provider, and no production credentials were used.

**Residual:** no automated dependency-scanning gate in CI yet (Phase 11/G12); lockfile is committed.

---

## Out of scope for this phase (by explicit constraint)

- Attacking external providers (Rithmic, Whop, Stripe, Resend, Twilio, GitHub) or any internet system.
- Touching real customer money, real payment rails, real payouts, or production/live Rithmic.
- Rewriting git history to purge a secret (none found committed); backups
  `origin/backup/phase3-wip` and `origin/backup/ident-backup` are untouched.

## Priority residual risks (carried forward)

1. **HTF-9** — affiliate-ledger idempotency gap (P2; before any real affiliate rail).
2. **HTF-10** — safety mutations API-operable but not surfaced in the console UI.
3. **Real-money boundaries (G1/G2/G3/G8)** — payments/KYC/payout/live-feed not wired; the current safety
   is "fail-closed to no-op", proven; "real money handled safely" is a later phase.
4. **Infra (G12)** — no CI dependency gate, no backup attestation, no edge DDoS/WAF; Phase 11.
