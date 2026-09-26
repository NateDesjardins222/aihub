# EXTERNAL DEPENDENCIES

**Happy Trader Funding — every external provider/dependency, its status, owner, and next action.**
Phase 12 (2026-09-26). No contacts are fabricated; no service is purchased or configured here.

Status legend: **SOFTWARE READY** = the code seam/adapter exists and fails closed · **NOT WIRED** = no
production account/credentials · **EXTERNAL** = requires a business/legal/provider action Claude cannot do.

| # | Dependency | Purpose | Software | Account/creds | Agreement/rights | Owner | Blocks | Next action |
|---|---|---|---|---|---|---|---|---|
| 1 | **Whop** (commerce) | accept customer payment | READY (fail-closed selector, signed webhook, idempotent) | NOT WIRED | business review + terms | NATE + PROVIDER | real purchase | open/verify Whop business account; create product/plan IDs; set prod webhook + `WHOP_*` creds |
| 2 | **Stripe Identity** (KYC) | verify one real human per customer | READY (seam; fail-closed) | NOT WIRED | data-processing terms | NATE + PROVIDER | real payout (gate); optionally purchase | enable Stripe Identity; prod API keys + webhook |
| 3 | **Payout provider** (ACH/business payouts) | disburse to funded traders | PARTIAL (provider-neutral registry; mock only; no adapter) | NOT SELECTED | business payouts + recipient verify | NATE + PROVIDER | real payout | select provider (ACH, recipient verification, idempotency, status callbacks, reconciliation, business eligibility); build adapter |
| 4 | **Rithmic** (market data + execution) | production futures data + order routing | READY deterministically (Rithmic Test, honest seam, no fallback masking) | TEST only | **commercial/production rights unknown** | NATE + PROVIDER | live customer trading env | confirm commercial agreement, production env, entitlements, session/user model, limits, redistribution/display rights |
| 5 | **CME/COMEX/NYMEX** (exchange data rights) | lawful market-data display/redistribution | n/a (policy) | n/a | **exchange data agreement unknown** | NATE + PROVIDER + COUNSEL | live customer trading env | confirm exchange data entitlements separate from Rithmic access (display vs non-display, redistribution) |
| 6 | **Resend** (transactional email) | customer notifications | READY/seam (suppress, never fake SENT) | NOT WIRED | sender domain verification | NATE + PROVIDER | beta comms (soft), real money (needed) | create account; verify sending domain (SPF/DKIM/DMARC); prod key |
| 7 | **Twilio** (SMS, optional) | optional notifications/2FA channel | seam (mock/suppress) | NOT WIRED | — | NATE | optional | defer unless MFA/SMS chosen |
| 8 | **Production hosting** | run the API/workers/WebSocket/engine | n/a | NOT PROVISIONED | — | NATE + INFRASTRUCTURE | any external beta w/ real infra | choose host supporting long-lived Node/WS + persistent workers (`PRODUCTION_ENVIRONMENT_PLAN.md`) |
| 9 | **Managed PostgreSQL** | production source of truth | READY (schema/migrations) | NOT PROVISIONED | — | NATE + INFRASTRUCTURE | any external beta w/ real infra | provision managed PG16 + backups/PITR + encryption |
| 10 | **Object storage** (S3 or equiv) | durable certificate artifacts (HTF-27) | PARTIAL (local-FS; S3 seam throws) | NOT WIRED | — | NATE + INFRASTRUCTURE | public launch (beta tolerable) | wire provider-backed store + signed URLs + backup |
| 11 | **Secret manager** | production secrets + rotation | n/a | NOT PROVISIONED | — | NATE + INFRASTRUCTURE | real money | choose secret injection + rotation + access audit |
| 12 | **Alert delivery** (email/SMS/incident tool) | deliver the alert conditions in OBSERVABILITY.md | PARTIAL (conditions defined; no delivery channel) | NOT WIRED | — | NATE + INFRASTRUCTURE | real money | pick a channel; wire critical alerts |
| 13 | **Domain + TLS** | primary site + API | n/a | UNKNOWN | — | NATE | any external beta | confirm domain ownership; TLS |
| 14 | **Legal counsel** | Terms/Privacy/Trader Agreement/disclosures, structure | drafts only | n/a | engagement | NATE + COUNSEL | real purchase/payout | engage counsel with `LEGAL_COUNSEL_REVIEW_PACKAGE.md` |
| 15 | **CPA / accounting** | bookkeeping, tax, 1099/vendor | n/a | n/a | engagement | NATE + CPA | real money scale | engage; define revenue/payout/refund tracking |
| 16 | **External security review / pentest** | independent security assurance | scope package ready (Phase 10) | n/a | engagement | NATE + REVIEWER | public launch | engage a reviewer with the Phase 10 scope |
| 17 | **Business banking / entity** | settlement + payout funding source | n/a | NOT DONE | — | NATE | real money | form entity (name/state/EIN); open business bank account |

## Fallback tolerance (PART 90)
- **Market data / execution (Rithmic):** if unavailable, trading pauses (honest stale/disconnected state;
  no invented prices/fills). Tolerable for minutes; a prolonged outage halts trading — acceptable.
- **Commerce:** if unavailable, checkout fails safely (no free account). Tolerable; purchases pause.
- **KYC:** if unavailable, provisioning/payout gate blocks. Tolerable; onboarding pauses.
- **Payout provider:** if unavailable, payouts stay PAYABLE and reconcile later; never blind-retry.
- **Email:** if unavailable, notifications suppress (never fake SENT); no business truth lost.
- **Object storage:** if unavailable, certificate render is retryable; no financial effect (HTF-27).
- No multi-provider redundancy is designed now (PART 90) — single-provider with safe pause is the posture.

## Cost categories to evaluate later (PART 89 — no pricing guessed)
hosting, managed DB, object storage, email, payments (Whop fees), KYC (per-verification), payout
(per-disbursement + ACH), Rithmic + exchange data fees, external security review, legal, accounting.
