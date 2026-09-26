# PHASE 12.5 — RELEASE CANDIDATE 0 (HUMAN ACCEPTANCE CANDIDATE)

**Happy Trader Funding.** Release-candidate cleanup + human-acceptance preparation.
Entry HEAD `8c4d239` (Phase 12). This document records what changed, why it is safe, and what
RC0 is — and is not.

> RC0 is a **human-acceptance candidate**, not an authorization to invite users, accept money, or
> send payouts. Only Nate can accept the product experience (`HUMAN_ACCEPTANCE_CHECKLIST.md`).

---

## What RC0 delivers (all in Phase 12.5 scope)

### 1. Canonical validation FULLY GREEN, twice (HTF-29)
The two tests that were non-deterministic in the full monolithic run were the ones that verified
the **whole shared org**. They are now scoped to exactly the invariant under test:
- `db/schema.test.ts` "carry exactly the terms…": the profile lookup is scoped to the seeded `atlas`
  org (`account_profiles` is multi-tenant; other suites create second orgs with the same keys), and
  pinned to the imported v1 version.
- `http/admin.test.ts` "keeps the audit chain intact…": replaced the whole-org endpoint assertion
  with a `verifyAuditChain(db, orgId, { since })` segment check captured before the concurrent burst.

No audit verification was weakened: `verifyAuditChain` still checks content hash + prevHash linkage;
a `{since}`-scoped verify is a valid partial-chain check whose first row legitimately skips linkage.
Result: **197 files / 2875 tests green** on the entry commit, and green twice from a clean seed at RC0
(see validation record below).

### 2. Owner MFA (TOTP) + secure production bootstrap (HTF-6a / G6)
- **TOTP** on `node:crypto` only (no new dependency): `auth/totp.ts` (RFC 6238, SHA-1, 6 digits, 30s
  step, ±1 window, constant-time compare) and base32 (RFC 4648).
- **At-rest sealing**: `auth/secret-box.ts` (AES-256-GCM, key via HKDF from `JWT_SECRET`) — a database
  dump alone cannot mint codes.
- **Domain**: `auth/mfa.ts` — two-phase enrollment (secret stored but not "enrolled" until a code is
  proven, so a half-finished setup can never lock anyone out), single-use recovery codes (hashed,
  consumed by an atomic UPDATE), disable, regenerate.
- **Two-step login**: `/auth/login` returns a short-lived challenge for an MFA account (no session);
  `/auth/mfa/verify` exchanges challenge + factor for the session. Un-enrolled users are unaffected.
- **Rate control**: the MFA endpoints carry the same per-IP budgets as the rest of the auth front door.
- **Web**: a login challenge step and a Portal → Security panel (enroll, recovery codes shown once,
  disable requiring password + a live factor).
- **Production owner bootstrap** (not a seed): `platform/owner-bootstrap.ts` + `scripts/bootstrap-owner.ts`
  (`pnpm --filter @atlas/server owner:bootstrap`). Creates the FIRST SUPER_ADMIN only, requires
  `ALLOW_OWNER_BOOTSTRAP=true` + env credentials, never prints the password, refuses if an owner exists.
  The dev seed still refuses production.
- **Migration** `0035_owner_mfa.sql` (users.mfa_secret / mfa_enrolled_at; `mfa_recovery_codes`).
- **Tests**: `auth/mfa.test.ts`, `http/auth-mfa-http.test.ts`, `platform/owner-bootstrap.test.ts`
  (happy-path bootstrap runs inside a rolled-back transaction so the shared seeded DB is untouched).

### 3. Inactivity policy enforcement wired (HTF-18)
The existing, documented, idempotent `runInactivitySweep` is now bound to a durable interval worker
(`platform/inactivity-worker.ts`, started/stopped in `app.ts`) **and** an on-demand owner route
(`POST /api/v1/admin/ops/system/inactivity-sweep`, gated by `system.jobs.manage`). The rule was not
invented or changed; the sweep is server-time authoritative and skips already-closed accounts. Proven
idempotent across ticks by `platform/inactivity-worker.test.ts`.

### 4. Rule-copy consistency (HTF-31)
Family rule bullets are now DERIVED from the numeric config by `familyRuleBullets()` in
`packages/contracts/src/product-catalog.ts` — the single source. `FAMILIES` maps a numeric base through
it; only genuinely qualitative notes remain authored (no drifting numbers). The marketing HomePage
consistency figures read `family(...).evalConsistencyPct` rather than literals. `rule-facts.test.ts`
fails if any bullet's number disagrees with config. No second config was created.

### 5. Critical error / 404 UX (HTF-30)
`main.tsx` wraps the app in a top-level `ErrorBoundary` (branded "Something went wrong" + reload; the
stack is logged for an operator, never shown to the customer). Unknown top-level routes render a branded
`NotFound` (`App.tsx` `isKnownRoute`).

### 6. Human-acceptance preparation
`HUMAN_ACCEPTANCE_CHECKLIST.md` is now executable in one sitting: a single startup procedure with
deterministic seed fixtures and credentials, scripts for Public/Checkout/Portal/MFA/Atlas/Owner/Support/
Certificates/Failure states, and a PASS/FAIL/NOT TESTED results record. New rows cover MFA (C2), the 404
+ error boundary (A/H), and the on-demand inactivity sweep (E).

---

## Validation record (RC0)

- **Typecheck:** `pnpm -r typecheck` — all 5 projects clean.
- **Build:** `pnpm build` (packages + server) and `pnpm --filter @atlas/web build` — clean.
- **Migration:** `0035_owner_mfa.sql` applies on a fresh DB; columns + table verified.
- **Canonical validation:** `bash scripts/prepare-test-db.sh` then `pnpm test` from the repo root —
  run twice from a clean seed on the RC code (commit `7e3df44`):
  - **RUN 1: 202 test files, 2922 tests — ALL PASS (exit 0).**
  - **RUN 2: 202 test files, 2922 tests — ALL PASS (exit 0).**
  Fully green both times, zero failures — no "passes-in-isolation", no "explained red". (The one
  transient adversarial-lock flake seen earlier was a fixed-`settle()` timing race; it is now hardened
  with a deterministic wait on the persisted `LOCKED` status, so the two clean-seed runs above are
  reproducibly green.)

## RC0 checkpoint
- **RC0 — HUMAN ACCEPTANCE CANDIDATE.** Validated code commit: `7e3df44` (this document's commit adds
  only this record). Tag: `rc0-human-acceptance-candidate`.

## Explicitly NOT done in 12.5 (out of scope, by mandate)
No new products/rules/payout models/certificates; no affiliate expansion; no website/Atlas/Owner
redesign; no new chart tools/indicators; no broad refactors; no real payment/payout activation; no
production Rithmic; no external service provisioning; **no claim of human acceptance** (only Nate can);
Phase 13 not started.

## Standing safety posture (unchanged)
No real customer money, no real payouts, no production/live Rithmic, no external provider purchases, no
legal filings, no agreements signed, no users invited. Secrets are reported PRESENT/NOT PRESENT only;
no MFA secret, recovery code, seed password, token, `.env`, PII or DB dump is committed. Backups
`origin/backup/phase3-wip` and `origin/backup/ident-backup` untouched.
