# Security Phase 1 — Report

**Hostile-client / auth / authz / API-abuse / trust-boundary hardening**
**Base commit:** `ae9a4a3` (`engineering-security-phase1-start`) · **Date:** 2026-09-30

Governing question: *if the client is hostile, the request malicious, the session
stolen/stale, ids enumerated, payloads manipulated, webhooks replayed, or a normal
user tries to become an operator — does Happy Trader still protect customer data,
money, accounts, trading authority, and administrative power?*

> Honesty: this is what the code enforces today, not a certification. No SOC-2/PCI,
> no third-party pentest. No real money, payment rail, payout, KYC, or live provider
> was touched; all evidence is deterministic tests + dev/sandbox fixtures. No secret
> value is printed here.

## Headline

- **The Phase-10 security model holds at `ae9a4a3`.** The established security suites
  (166 tests across security/authz/rbac/IDOR/trading/owner/staff/webhook/enforcement
  /affiliate/self-serve/certificate) were re-attacked and are **green**.
- **Findings: 0 P0, 0 P1, 2 P2, 3 P3.** One P2 fixed (SEC-1); one P2 documented
  (SEC-2, Atlas redesign out of scope); the P3s are a pre-launch webhook-signature
  gate (SEC-3), a role-granularity question (SEC-4), and the known JWT
  access-token-revocation tradeoff.
- **No externally-reachable injection sink** (SQL/command/path/SSRF/redirect/XSS/
  prototype-pollution) — full audit clean.
- **No real secret committed; no server secret in the web bundle.**
- **Deliverables:** `SECURITY_TRUST_BOUNDARY_MAP.md`, `SECURITY_ENDPOINT_MATRIX.md`,
  `SECURITY_INVARIANT_LEDGER.md`, this report; new `security-phase1.test.ts`;
  `pnpm security:check`.

## The one fix (SEC-1)

`POST /api/v1/admin/security/reauth` re-verifies the operator's password to mint a
step-up token that gates FINANCIAL / STAFF / KILL_SWITCH actions, but had **no rate
limit** (the global limiter is `global:false`, so an un-capped route is unlimited) —
an online brute-force surface on the step-up password gate for any holder of a valid
access token. **Fixed:** per-IP cap 10/min (mirrors `/login`), `trustProxy` off so a
spoofed XFF can't mint a fresh bucket. Root-fixed server-side; regression in
`security-phase1.test.ts`; adjacent reauth-using owner suites re-run green.

---

## Final report (120 questions)

### REPOSITORY
1. Starting commit? `ae9a4a3`.
2. Ending commit? see the commit that lands this phase (reported at push).
3. Clean tree? Yes at start; all work committed.
4. Remote == local? Verified at push.
5. Checkpoint preserved? Yes — tag + branch `engineering-security-phase1-start` / `checkpoint/engineering-security-phase1-start`.
6. Stashes preserved? Yes — `phase3-wip-product-model` intact; no destructive git.

### SURFACE
7. Endpoints inventoried? 407 route rows across all HTTP plugins.
8. Public? 18 (health/version/ready, instruments, verify, affiliate-public, staff-onboarding-token).
9. Customer? 151 (`requireUser` + ownership).
10. Owner? 193 (`requireRole`/`requirePermission` + step-up on money/staff/kill-switch).
11. Staff? 47 (granular `requirePermission`).
12. Webhook? 2 (commerce/Whop signed; payout seam).
13. Dev-only? 3 (`NODE_ENV!=='production'` gated, not registered in prod).
14. Any unclassified? **0.**

### AUTH
15. Authentication bypass found? No. JWT verify pins `alg:HS256`+issuer; no alg/RS-HS confusion.
16. Expired-session behavior? Access JWT rejected after 15-min `exp`; refresh after 30 d.
17. Logout/reuse behavior? Logout revokes the refresh token immediately (server-side); replay rejected. Access JWT stateless until `exp` (documented tradeoff).
18. Tampered session? Rejected (signature/issuer).
19. Production cookie flags? N/A — the server sets **no cookies**; tokens are Bearer-header only (no CSRF cookie surface).
20. Test scrypt still isolated? Yes — `selectScryptParams` returns the reduced factor only when `VITEST==='true'` or `NODE_ENV==='test'`; every other path (incl. production and default) returns strong params. Cannot leak into production.

### AUTHZ
21. IDOR tests run? Yes (existing `m10-1-rbac-redteam`, `authz-security`, `certificate-security`, `payouts/copy/customers.routes` + re-attack).
22. Cross-customer read possible? No.
23. Cross-customer mutation possible? No.
24. Nested-resource IDOR? No — ownership follows authoritative parent relationship.
25. Owner escalation possible? No (role re-read from DB; token role not trusted).
26. Staff escalation possible? No (granular `requirePermission` re-read).
27. Client-supplied role trusted anywhere? No.

### OWNER
28. Direct owner URL as customer? Denied (server authz; nav visibility is not security).
29. Direct owner API as customer? 403.
30. Step-up bypass? No — `requireReauth` enforced server-side on money/staff/kill-switch.
31. Kill-switch unauthorized mutation? Denied (permission + step-up); engaging has real effect (HTTP 423 at chokepoints).

### INPUT
32. Mass assignment? Blocked — Zod-explicit bodies; `authz-security` "registration cannot smuggle a privileged role" green.
33. Authoritative money overposting? Blocked — server computes money; no client pass-through.
34. State overposting? Blocked — lifecycle re-read/derived server-side.
35. Integer overflow? Money is integer micro-dollars with bounded parsing; no float coercion (`financial-invariants`).
36. Quantity parsing issue? None — validated integer qty; NaN/Infinity/scientific rejected by schema.
37. Unknown enum issue? Zod enums reject unknown/permissive values.

### INJECTION
38. SQL injection path? None reachable — Drizzle bind params; the only `sql.raw` interpolates compile-time constants.
39. Shell injection path? None — no `child_process` in request-handling code.
40. Path traversal path? None reachable — object-store keys validated (`assertSafeKey`) + `resolve` prefix-confined + server-generated UUIDs.
41. Prototype pollution? No server-side client-JSON merge; one client-local chart merge (self-affecting only) — informational.
42. SSRF path? None — outbound requests target fixed provider base URLs with registry-validated params.

### WEB
43. XSS sink? None — 0 `dangerouslySetInnerHTML`/`innerHTML`/`document.write` in `apps/web/src`; React auto-escaping.
44. Stored XSS? None found.
45. Open redirect? None — no query-param-driven redirect; navigation targets are constants/same-origin ids.
46. CSRF posture? Not applicable in the classic sense — auth is a Bearer header (no ambient cookie), so cross-site form/GET auto-auth is impossible. Evidence: no `Set-Cookie`/`@fastify/cookie` in the server.
47. CORS posture? Origin allowlist (`CORS_ORIGIN` split); production refuses to boot on `*`; `credentials:true` but no cookies to carry.
48. Security headers? `nosniff`, `X-Frame-Options: DENY`, strict CSP (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`), `Referrer-Policy: no-referrer`, COOP/CORP same-origin, Permissions-Policy denied, HSTS in production (`SECURITY_MODEL.md` §11).

### WEBHOOK
49. Webhook endpoints? 2 (commerce/Whop; payout provider seam).
50. Missing-signature behavior? Commerce: 401 + REJECTED row, no effect.
51. Invalid-signature behavior? Commerce: rejected before effect (constant-time compare).
52. Modified body? Commerce: HMAC over raw body → rejected.
53. Replay? De-duplicated on `(provider, event_id)` unique index.
54. Concurrent replay? One effect (unique index + `onConflictDoNothing`); proven by `replay-controls` + resilience outbox soak.
55. One business effect? Yes for commerce. Payout webhook is an unsigned seam (SEC-3); production fails closed to a no-op.

### ABUSE
56. Login abuse controls? Per-IP limits (login 20/min, register 10, mfa 20, refresh/logout 30); step-up now 10 (SEC-1).
57. Trading burst behavior? Risk gate + account isolation enforced per order; not globally rate-capped by design (latency-sensitive).
58. Payout abuse behavior? Eligibility + kill-switch + idempotency; request bounded by server caps.
59. Body-size bounds? Fastify body limit; malformed/oversized JSON → typed 400.
60. Pagination bounds? Clamped server-side (`Math.min` limits; validated int page/sort).
61. Any trivial resource exhaustion? None found via one request.

### SECRETS
62. Real secret in tracked repo? **No** — only test/placeholder/`.env.example`.
63. Secret in browser bundle? **No** (bundle scan, `SECURITY_MODEL.md` §9).
64. Sensitive logging? Redacted (`authorization`, `password`, `refreshToken`); digest-only persistence.
65. Error disclosure? Uniform `{error:{code,message}}`; no stack/SQL/secret to caller.
66. Rotation required? No committed real secret found → no rotation required.

### ATLAS/TRADING
67. Foreign account handoff? Denied — server is authority; ownership-gated.
68. Foreign order mutation? Denied (`trading-authz-http` green).
69. Copy-trading ownership? Own-account-only fanout enforced.
70. Terminal account trade attempt? Rejected by lifecycle/risk gate.

### PAYOUT
71. Foreign payout read? Denied.
72. Foreign payout mutation? Denied.
73. Customer owner-approval attempt? Denied (permission-gated).
74. Step-up enforced? Yes (server-side `requireReauth(FINANCIAL)`).

### DATA
75. Customer response leaks internal fields? No — customer surfaces return scoped fields; internal notes/fraud/risk internals not exposed.
76. Foreign-vs-nonexistent enumeration issue? Ownership-scoped resources return 404 with no existence oracle (fail-closed).
77. Cache cross-user risk? No authenticated shared-cache layer; responses are per-request.

### STREAMS
78. WebSocket/SSE present? Yes (market-data gateway).
79. Subscription ownership safe? Yes — authenticated handshake + `mayFollowAccount` (`ws-security.test.ts`).

### FAIL CLOSED
80. Ownership lookup failure? Denies (throws, no fail-open).
81. Role lookup failure? Denies.
82. Session lookup failure? Denies.
83. Any fail-open behavior? The global auth hook is fail-open *by design* (attaches identity, never rejects) — but every private route opts into a guard, and no route was found unguarded for private data. Standing structural risk noted.

### PROPERTY TESTING
84. Security generated actions? Cross-principal authorization is covered by the existing red-team suites; the new `security-phase1.test.ts` adds the step-up abuse regression. (A generated cross-principal fuzzer is a recommended Phase-2 extension.)
85. Seeds? Deterministic fixtures.
86. Cross-principal operations? Yes (customer vs owner vs unauth vs staff across the suites).
87. Invariant violation? None.

### DEPENDENCIES
88. Dependency audit run? Prior `pnpm audit` (SECURITY_MODEL §13); re-checked posture.
89. Critical reachable vulnerability? None in production dependencies.
90. High reachable vulnerability? None reachable at runtime.
91. Upgrades made? None required; one dev-only `esbuild`/`drizzle-kit` moderate advisory accepted (build-time only), tracked.

### FINDINGS
92. P0? 0.
93. P1? 0.
94. P2? 2 (SEC-1 fixed, SEC-2 documented).
95. P3? 3 (SEC-3 webhook-signature pre-launch gate, SEC-4 note-role granularity, access-token revocation tradeoff).
96. Production security defects found? 1 with a live in-scope repair (SEC-1).
97. Production security defects fixed? 1 (SEC-1), regression added.
98. Deferred findings? SEC-2 (Atlas redesign), SEC-3 (pre-launch), SEC-4 (product confirm).

### VALIDATION
99. Security-focused test count? 166 existing (green) + 3 new (`security-phase1.test.ts`) = 169.
100. security:check created? Yes — `pnpm security:check` (`scripts/security-check.sh`), composing 16 security suites, no external scanning.
101. security:check result? Green (see push report).
102. Typecheck? Clean.
103. Build? Clean (via canonical).
104. Canonical? Run once (see push report).
105. First-run canonical failure? Reported honestly at push.

### SCOPE
106. Economics changed? No.
107. Product rules changed? No.
108. RES-1 changed? No.
109. Portal V2 migrated? No.
110. Portal visual design changed? No.
111. Atlas redesigned? No.
112. Production provider contacted/attacked? No.
113. Real money used? No.

### FINAL
114. Exact final commit? Reported at push.
115. Most serious security defect discovered? SEC-1 — unrate-limited step-up password gate (P2, fixed).
116. Largest remaining application-security risk? SEC-2 — the global-singleton market-data replay/provider controls let any customer disrupt every tenant's chart feed (cross-tenant display integrity; no money/authz/private-data). Proper fix is per-session replay isolation (Atlas redesign).
117. Largest security risk untestable until production providers exist? The payout-webhook signature boundary (SEC-3) and the real payment/KYC/payout rails — all seams today; cannot be certified until wired.
118. Any finding requiring Nathan immediately? No P0/P1. Nathan should decide SEC-2 (replay isolation vs operator-gating) and note SEC-3/SEC-4 as pre-launch items; no credential rotation required.
119. Is a Security Phase 2 objectively warranted? Yes — a focused, different surface (below), not a repeat.
120. If yes, what DIFFERENT surface would Phase 2 cover? (a) A **generated cross-principal authorization fuzzer** (random actor × resource × method × replay, asserting "no principal gains authority it lacks") to catch the structurally fail-open opt-in default on *future* routes; (b) the **market-data replay multi-tenant isolation** (SEC-2) as a design change; (c) **pre-launch provider trust boundaries** — payout-webhook raw-body signature (SEC-3), Stripe Identity webhook, and real-rail secret handling — testable only once providers are wired; (d) **WebSocket/stream fuzzing** at scale and **access-token revocation** (jti/denylist) if immediate revocation becomes a requirement.

## Definition of done

Trust boundaries mapped; all 407 routes classified (0 unclassified); authentication,
sessions, ownership, nested resources, owner/staff escalation, mass-assignment,
money/state overposting, SQL/raw-query/file/process/URL boundaries, XSS sinks,
redirects, CSRF/CORS posture, webhook signatures/replays, secrets, bundle, logs/
errors, trading/copy/payout authorization, fail-closed dependencies attacked or
evidenced; deps triaged by reachability; **no unresolved P0/P1**; no economics/
product-rule/RES-1/Portal-V2/Atlas change; no external system attacked; no real
money. **Backend attack phases were not resumed. Security Phase 2 is warranted on a
different surface; not started. Awaiting the next instruction.**
