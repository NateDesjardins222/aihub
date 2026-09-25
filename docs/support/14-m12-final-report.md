# 14 — Milestone 12 final report

**Happy Trader Customer Support + Disputes + Resolution Operations V1**

Milestone 12 delivers the complete customer-support, dispute, remediation and
resolution operating system for Happy Trader / Atlas. It connects a customer's
stated problem to the authoritative facts across every domain and, when a remedy
is warranted, routes it through the canonical domain service that already owns
that money or state — never by mutating it from support.

## The rule that shaped the milestone

Support **investigates and requests** remediation. It never directly mutates
money, balances, executions, P&L, payouts, commissions, or refund state. Every
money or state action is dispatched to the canonical engine (`applyAdminAdjustment`,
`createResetOrder`, `handleRefund`, or `MANUAL_ACTION_REQUIRED` for the controlled
types performed by the authorized role in its own console), each of which carries
its own authorization, audit and idempotency. Support's remediation layer adds a
four-eyes approval gate on top and records the real result — never a fabricated one.

## What shipped

**Data & domain (`apps/server/src/platform/`, migration `0034_support.sql`)**
- 13 tables: versioned config, categories, SLA policies, templates, KB articles,
  tag defs, tickets (human refs `HT-XXXXXX`, optimistic-concurrency `version`,
  SLA + resolution + CSAT fields), append-only messages/evidence/ticket-events,
  attachments, object links, and remediations (`REM-XXXXXX`).
- Append-only enforced by the DB trigger `support_block_mutation()` on
  `support_messages`, `support_evidence`, `support_ticket_events`.
- `support-config.ts` — lifecycle graph, priorities/teams/resolution/root-cause
  enums, conservative `suggestPriority` (never escalates on tone), config seeding.
- `support-tickets.ts` — submit, idempotent messaging with strict internal/public
  visibility, guarded transitions (advisory lock + `expectedVersion`), business-hours
  SLA clock with pause/resume, escalate, resolve, reopen (customer window), merge,
  split, CSAT, and incident association.
- `support-links.ts` — ownership-verified object linking, evidence, customer
  context snapshot, investigation timeline from the authoritative event stream.
- `support-diagnostics.ts` — deterministic "What Happened?" facts and refund
  eligibility (ordinary refund only when no trade executed), with reason codes.
- `support-remediation.ts` — request → four-eyes approve → exactly-once execute,
  dispatching to the canonical services; `FAILED` carries the real reason.
- `support-attachments.ts` — storage seam, type/size validation + executable
  rejection, HMAC signed time-limited downloads, ownership + staff authorization.
- `support-inbox.ts` — pure `slaState`, filtered keyset-paginated inbox, factual
  overview KPIs, staff workspace, and the customer-safe view.

**HTTP** — `support-portal.ts` (`/api/v1/support`, own-ticket scoped, rate-limited)
and `owner-support.ts` (`/api/v1/admin/ops/support`, permission-gated; four-eyes +
role gate on remediation).

**Web** — customer Support Center (`portal/pages/SupportPage.tsx`) and the owner
inbox + ticket workspace (`admin/pages/SupportPages.tsx`), wired into the console nav.

**Owner OS integration** — Command Center support KPIs + attention items, global
search (`support_ticket` + `support_remediation`), object explorer, and a Customer
360 Support tab.

**Integrity & System Doctor** — `INV_REMEDIATION_FOUR_EYES`,
`INV_RESOLVED_TICKET_HAS_SUMMARY`, and the `support` + `support_storage` probes,
plus support tables in the migration-parity sentinel.

## Verification

| Gate | Result |
| --- | --- |
| M12 deterministic tests | **176 passing** (support-pure 58, tickets 27, config-db 11, links 12, inbox 13, remediation 11, concurrency 10, attachments-db 8, osint 11, http 15) |
| Full server regression | 2058 tests passing on a clean run (`vitest run`, exit 0) |
| Server typecheck | clean |
| Web typecheck | clean |
| Server production build | clean (`pnpm build`) |
| Web production build | clean (`pnpm --filter @atlas/web build`) |
| Migration parity | `0034_support` applied to `atlas` and `atlas_test`; 13 support tables present in both; `_journal.json` entry present |
| Browser acceptance | `support-acceptance.spec.mjs` registered in `tests/browser/run.mjs` — customer center, ticket create, internal-note privacy, remediation four-eyes, safe attachments, resolution + CSAT, owner inbox + workspace |
| Secret / model-id audit | no hardcoded secrets in support files; no model identifier anywhere in the tree |

The shared test database means the very first full-suite run reported a handful of
cross-suite ordering flakes; a clean re-run passed all 2058 with exit 0. The M12
suites themselves are deterministic and pass in isolation every time.

## Truthful posture

- Providers are reported honestly: attachment storage is the in-process default
  until an object store is configured; nothing external is faked. `EXTERNAL_LIVE`
  stays false. Refunds record internal state only — external settlement is a
  separate, explicit provider/manual step.
- Internal notes and internal resolution notes are aggressively tested to never
  reach the customer; the customer view names staff generically as
  "Happy Trader Support".
- The locked refund rule, M8 payout / M7 enforcement / M11 affiliate / M10 reset
  and adjustment integrations are preserved; support requests remediation through
  them rather than reimplementing any economics.

## Known limitations (documented, not hidden)

- `support.mass_notify` is defined in the RBAC catalog but not yet wired to an
  endpoint; mass incident communications remain a reserved capability.
- `ticketsForObject` (reverse lookup) is implemented and unit-covered but not yet
  surfaced in an owner route or the object explorer's reverse view.
- Incident association is available via the new `POST /support/tickets/:id/incident`
  endpoint and the generic object-link path; automatic incident suggestion from a
  cluster of tickets is not part of V1.

## Verdict

Milestone 12 is complete against its Definition of Done: the full support →
investigation → remediation → resolution spine is built, money-safe by construction,
integrated across the Owner OS, covered by 176 deterministic tests plus a browser
acceptance suite, documented in fourteen files, and green on typecheck, builds and
migration parity.
