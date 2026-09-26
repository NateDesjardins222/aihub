# PRE-LAUNCH FEATURE FREEZE

**Happy Trader Funding — what may be built, and when.** Phase 12 (2026-09-26). Purpose: prevent feature
creep. The platform is feature-complete for its scope; the path to launch is readiness, not features.

## Hard constants (do NOT change)
- **Exactly 10 commercial products** (CORE 25/50/100/300 GOLD, SELECT 25/50/100, DAILY 25/50/100). PRACTICE
  is a separate free playground. **No new account types.**
- **No new certificate types.** No affiliate feature expansion. No website redesign (identify blockers
  only). Brand = Happy Trader Funding; platform = Atlas. No renames.

## REQUIRED BEFORE CLOSED BETA (invite-only, no real money)
- Production owner bootstrap + MFA (no seed password) — **G6 gap (software, buildable)**.
- Alert delivery channel wired to critical conditions — software + external.
- Human acceptance: Nate completes Atlas + Portal + Owner OS checklists (`HUMAN_ACCEPTANCE_CHECKLIST.md`),
  including the manual Owner-OS mouse-wheel scroll.
- HTF-29 test-isolation cleanup so canonical validation is trustworthy (small, test-only).
- (If beta runs on real infra) production hosting + managed Postgres + backups + domain/TLS.

## REQUIRED BEFORE REAL MONEY (purchases)
- Everything in `REAL_MONEY_BOUNDARY.md` Boundary A: entity, bank, counsel-approved documents, Whop
  production credentials + webhook, production infrastructure, secret manager, monitoring/alerting.
- Object storage decision if certificates are issued in that mode (HTF-27) — beta-tolerable, launch-blocking.

## REQUIRED BEFORE REAL PAYOUTS
- Everything in `REAL_MONEY_BOUNDARY.md` Boundary B: production KYC live, real payout provider + adapter +
  recipient verification, business funding/reserves, payout/tax review, incident runbook adopted.

## REQUIRED BEFORE PUBLIC LAUNCH
- Commercial market-data rights (Rithmic + exchange) confirmed for the live customer trading environment.
- External security review/pentest complete.
- Fully green canonical validation (no permanent explained-red).
- Accessibility + broken-link + 404 pass on public site.

## POST-LAUNCH (do not block launch)
- Metrics/tracing export endpoint (HTF-19); console buttons for safety mutations (HTF-10).
- Object-storage migration if deferred; affiliate payout provider; notification breadth.
- Performance/visual polish beyond beta-acceptable.

## DO NOT BUILD NOW
- New products, certificate types, affiliate features, copy-trading expansion, website redesign,
  multi-region/Kubernetes/microservices, marketing automation, analytics warehouse, public status page
  (unless a specific launch mode makes one launch-critical).

## Code-freeze rule once RC1 exists (PART 101)
Only these may land: P0/P1 fixes; provider integration required for the chosen launch mode;
human-acceptance fixes; legal copy changes; deployment fixes. No new features.
