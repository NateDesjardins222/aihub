# RC1 — HUMAN ACCEPTANCE REPAIR 1

**Happy Trader Funding.** Repair of the three RC0 human-acceptance blockers. From RC0 `536804c`.
Software-only; no real money, payouts, production Rithmic, or external providers. No Phase 13 work.

RC0 failed the owner's first desktop-browser test on three usability blockers. This repair fixes only
those, plus the deterministic fixture needed to prove them. Every fix is verified in a real Chromium at
1920×1080 / 1440×900 / 1366×768.

---

## Root causes

### FAILURE 1 — Customer dashboard could not scroll
`styles/theme.css` locks `html, body, #root { height: 100% }` + `body { overflow: hidden }` for the
TRADING TERMINAL (a viewport-locked chart app). Only the Owner Console released that lock (it adds
`owner-console` to `<html>`). The **Customer Portal** — and in fact every non-terminal surface
(marketing, checkout, onboarding, affiliates, verify) — is a tall document (`min-height: 100vh`, a sticky
header, content flowing down the page) but **never released the lock**, so `.pt` grew past the viewport,
was clipped by `body { overflow: hidden }`, and the wheel did nothing.

### FAILURE 2 — Owner OS could not scroll
Not a regression of the mechanism: `AdminApp` still adds `owner-console` and the release CSS is intact, so
Owner OS document-scrolls once reached. It was untestable because of FAILURE 3 (the owner never got in).
Now proven scrollable in-browser.

### FAILURE 3 — Owner could not access the Owner console
`/admin` (the operator console, branded "ATLAS operations") denies when the session role is `TRADER`. The
shared `LoginScreen` **pre-filled `demo@atlasfutures.local`** (the demo TRADER), so the owner was silently
signed in as a trader and correctly denied. Compounding it: the denial screen offered only "Back to the
terminal" — no way to switch accounts — and the dev database's `demo` user had been **elevated to
SUPER_ADMIN** by earlier session activity (the create-if-absent seed never corrected it), so the fixture
was not deterministic. RBAC itself was correct throughout (server `requireRole` unchanged).

---

## Fixes (files changed)

- **One clear scrolling architecture.** `styles/theme.css`: the document-scroll release now applies to a
  shared `html.doc-scroll` class (alongside the existing `owner-console`). New `lib/useDocumentScroll.ts`
  hook adds/removes it. Applied by every non-terminal surface: `portal/PortalApp.tsx`,
  `marketing/MarketingApp.tsx`, `checkout/CheckoutApp.tsx`, `onboarding/OnboardingApp.tsx`,
  `affiliates/AffiliatesPublic.tsx`, `affiliates/AffiliatePortal.tsx`, `portal/VerifyPage.tsx`. The Atlas
  terminal keeps the viewport lock (untouched). Owner OS keeps `owner-console` (untouched).
- **No silent trader login.** `components/LoginScreen.tsx`: the email field is no longer pre-filled.
- **Escape hatch from the denial screen.** `admin/AdminApp.tsx` + `admin/Admin.css`: the operator-denied
  screen now names who you are signed in as and offers a **"Sign out & switch account"** button (calls
  `signOut()` then returns to `/portal`), so a trader session is never a dead end.
- **Deterministic acceptance fixtures.** `db/seed.ts`: the dev seed now ENFORCES fixture roles on every
  run — `demo` is always a plain `TRADER`, `owner` is always an active `SUPER_ADMIN` — correcting any
  drifted existing row. (Dev-only; the seed still refuses production.)
- **Acceptance docs.** `HUMAN_ACCEPTANCE_CHECKLIST.md`: exact route map + logins, the Atlas-operations =
  Owner-OS clarification, the customer-vs-owner "Command center" distinction, and a scroll-first test.

## The stash (STEP 8)
The one stash, `phase3-wip-product-model`, is product-model seeding WIP — NOT the "log out / switch
account" admin UX the brief expected, and unrelated to the session problem (its product-model work is
already in `main` via `reconcileHtfProducts`). Left **untouched**, as instructed.

---

## Browser proof (real Chromium, wheel input)

Customer dashboard scroll — content taller than viewport, wheel moves the page:
- 1920×1080: scrollHeight 1736 > 1080; `window.scrollY` 0 → 656. **PASS**
- 1440×900: 1736 > 900; scrollY 0 → 836. **PASS**
- 1366×768: 1736 > 768; scrollY 0 → 968. **PASS** (`body overflow-y: auto`, `html.doc-scroll` present)

Owner OS (owner):
- Owner → `/admin` allowed (`.adm` shell, no denial). **PASS**
- Owner OS scroll 1366×768: scrollHeight 1361 > 768; scrollY 0 → 593 (`html.owner-console`). **PASS**
- Command Center nav present. **PASS**
- Pages render under the owner session: Command Center, Customers, Accounts, Payouts, System Health — all
  `.adm`, none denied. **PASS (5/5)**

Access + session switching:
- Trader → `/admin` DENIED (`.adm-denied`). **PASS**
- One context: trader denied → "Sign out & switch account" → owner login → `/admin` ALLOWED → clear →
  trader login → `/admin` DENIED again (no stale role leak). **PASS**

Fixture roles (DB): `demo = TRADER / is_admin f`, `owner = SUPER_ADMIN / is_admin t`. MFA: neither fixture
is enrolled, so login is single-step by design (the TOTP challenge only appears once an operator enrolls,
proven separately by the Phase 12.5 MFA tests).

Screenshots: `rc1-portal-{1920,1440,1366}.png`, `rc1-owner-os.png`, `rc1-trader-denied.png`,
`rc1-owner-{command,customers,accounts,payouts,system}.png` (session scratchpad).

## Validation
- Typecheck (5 projects) clean; web build clean.
- Canonical validation: <recorded on RC1 commit>.

## RC1 checkpoint
- **RC1 — HUMAN ACCEPTANCE CANDIDATE.** Commit: <recorded>. Not human-accepted — the owner must test RC1
  personally in a normal desktop browser.
