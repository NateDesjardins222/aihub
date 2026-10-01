# PRODUCT UX DEBT

**Happy Trader Funding — Product Recovery Phase 1.** Visual / interaction quality captured for a
LATER redesign phase. **Nothing here is solved in Phase 1** — Phase 1 repairs function and
connectivity, not appearance. Every item is severity **P3** (quality/polish) unless it also
blocks use, in which case it appears in PRODUCT_FUNCTIONAL_TRUTH.md instead.

This records the owner's RC1 human-acceptance feedback in substance, so the redesign phase has a
faithful brief. It is not an admission that the product is non-functional — functionally it is
largely E2E (see PRODUCT_FUNCTIONAL_TRUTH.md); it is that the *presentation* is not acceptable.

---

## Customer Portal — owner verdict: substantial redesign/rebrand later
- Overall look and feel reads as low quality / generic / "AI-generated".
- Layout unacceptable; visual hierarchy poor; typography needs significant work.
- The light/dark theme toggle is **removed** in Phase 1 (owner request); the eventual product
  should use **one intentional fixed visual system**, not a runtime toggle.
- Customer trust: the owner does not yet *trust* the controls even though they are wired
  (e.g. a personal max-loss limit). **Note:** this is a trust/legibility gap, not a functional
  one — the risk-control chain is proven E2E and enforced (PRODUCT_FUNCTIONAL_TRUTH.md §4). The
  redesign should make the enforcement *visible and legible* (clear "this limit is active and
  enforced by Atlas" state, live headroom, and the rejection reason surfaced in the terminal).

## Atlas — owner verdict: substantial product-quality work later (NOT this phase)
- Current visual/interaction quality unacceptable; complaints of lag/feel, tool quality,
  execution feel, overall presentation.
- Functionally correct but **UX-unacceptable** (a valid status): market data, execution,
  risk enforcement, brackets, P&L are all wired and correct.
- Known minor perf debt from the audit (not the cause of "feel", but worth noting):
  `useFreshness` polls REST every 5s/pane and replay status every 3s, duplicating the WS
  `md.status` heartbeat — low cost, dedupe later.

## Atlas — measured perf baseline (Phase 2, STEP 25)
Phase 2 **measured** the "laggy feel" instead of guessing (see `ATLAS_PERFORMANCE_BASELINE.md`):
server/data latency is low (API ~3 ms, bars ~17 ms, chart-ready ~300 ms headless) — there is **no
gross latency bug**. The complaint is **interaction quality** (chart feel, tools obstructing price,
DOM/order/bracket interaction), which belongs to the Atlas rebuild. Two concrete debts to fix in that
rebuild: the **753 KB monolithic JS bundle** (code-split) and **redundant 5s/3s polling** duplicating
the WS heartbeat. The rebuild should add input-to-paint instrumentation to profile the real "feel".

## Owner OS — evaluate separately AFTER natural accessibility
Now that the Owner Console is discoverable (Phase 1), its presentation can be reviewed on its
own. Not owner-reviewed yet. It is dense and functional; a later pass should judge information
architecture and density once operators actually use it.

---

## Future redesign categories (for the redesign phase to scope)
- **Information architecture** — customer vs owner "Command center" naming; portal vs terminal
  navigation model (the terminal has no "back to dashboard").
- **Navigation** — consistent, discoverable movement between Portal, Atlas, Owner OS.
- **Typography** — one intentional type system; remove generic defaults.
- **Spacing / density** — portal cards and tables.
- **Component system** — one deliberate component library (buttons, inputs, cards, tables,
  feedback/toasts, empty states).
- **Account cards / tables / forms** — legibility and trust cues.
- **Feedback states** — make server-authoritative state (locks, enforcement, pending) legible.
- **Branding** — one fixed Happy Trader identity (colour, mark, voice); no runtime theming.
- **Responsiveness** — phone/tablet passes.
- **Interaction quality** — Atlas feel, latency perception, tool polish.

**Do not act on any of the above in Product Recovery Phase 1.**

---

## Engineering Phase A additions (chart interaction + copy placement)

Captured for Atlas V2 human review. **None of these is a functional defect** — the interaction model,
selection reachability, pane resize, and copy fan-out are all objectively correct/fixed this phase.
These are the *feel/placement* items that require Nathan's eyes and belong to the visual rebuild.

- **Chart-tool physical feel (P3, human-only).** Grip grab-ease, handle target sizes, cursor
  affordances, and TradingView-grade polish. The 3px drag threshold, market-coordinate anchoring, and
  the (now-fixed) broad-phase hit boxes make every tool selectable and stable; how it *feels* to grab
  and nudge is a V2 tuning pass. See `ATLAS_TOOL_INTERACTION_MATRIX.md`.
- **Pane separator grab affordance (P3).** Volume and indicator panes are resizable by dragging the
  divider (native lightweight-charts separators, persisted split, double-click reset); the grip's
  visual weight / hover cue is a polish item, not a function gap.
- **Order-DOM copy status placement (P3).** Copy configuration is out of the DOM entirely; the DOM
  retains only a tiny "Copy · N accounts" status line. Its final placement/treatment (or removal) is a
  deliberate Atlas V2 decision — do not restyle speculatively.
- **Indicator/volume pane header density (P3).** Legend rows and pane headers are functional; visual
  density belongs to the same V2 chart pass.

**Do not act on any of the above before the Atlas V2 visual phase.**

---

## Engineering Phase B additions (interaction feel — human-only)

The interaction *mechanics* are proven objective this phase; what remains for Nathan's eyes is *feel*,
none of it a functional defect:

- **Pointer/drag smoothness & input-to-paint latency under a real feed (P3).** rAF-coalesced and clean in
  code; the perceived smoothness needs live browser profiling.
- **Marker/handle grab affordances & legibility (P3).** SL/TP/position marker grab targets and label
  legibility while price moves — a V2 tuning pass.
- **Multi-DPR crispness (P3).** The overlay re-rasterizes on DPR change; on-screen sharpness across the
  owner's actual monitors is a human check.
- **Per-chart account UX (P3, product decision).** Multi-chart ships with one terminal account; whether
  each chart should trade its own account is Nathan's call (`ATLAS_MULTI_CHART_READINESS.md`).

**Do not act on any of the above before the Atlas V2 visual phase.**

---

## Portal V2 — Accounts vertical (Product Rebuild Phase 2). Deferred, not defects.

- **Performance equity curve is a line only (P3).** V2 Performance shows the real equity curve as a plain
  line; V1's hover tooltip and P&L calendar are not yet ported. All shown metrics are real and it degrades
  truthfully with thin data. A richer, interactive curve is a later Portal-V2 phase.
- **Champagne hue / gradient / density fine-tuning (P3, visual).** The Detail surface uses the established
  Phase 0 language; final luxury tuning is Nathan's later call, not this phase.
- **`activatedAt` mirror gap (P4).** The web `AccountSummary` mirror omits `activatedAt` (unused by the
  Accounts vertical) — add when a vertical needs it (`KNOWN_ISSUES.md` PV2-2).

**Do not act on the above before the Portal V2 visual-acceptance phase.**

---

## Portal V2 — Human-Acceptance Review #2 (customer-experience restructure)

Debt deliberately carried from Review #2. None of these are faked in the product — each is a
documented seam with a truthful UI state today.

- **Portfolio P&L series endpoint.** `PortfolioPerformance` is built and renders a supplied
  authoritative `SeriesPoint[]`; the production cumulative-P&L projection endpoint is the seam
  to wire (see PORTAL_V2_PERFORMANCE_METRICS.md). Component ready; no fake data.
- **Payment-method provider flow.** Only the safe projection (brand/last-4/expiry) is shown;
  "Update" is a provider-hosted seam (`onManagePaymentMethod`). No in-portal card form.
- **Receipts.** `onViewReceipt` seam; the Receipt link renders only when a real receipt source
  is wired (hidden in the dev review rather than faked).
- **Certificate artifact in review.** `resolveArtifact` returns null without a session, so the
  vault shows "Preview available in your account". Production wires `/:id/{image,pdf}`.
- **Physical ("framed") certificate commerce.** Exists in V1 (`/order-framed`), not yet
  surfaced in V2.
- **Achievements** (distinct from certificates) not yet a V2 surface.
- **Notification preferences** are presented as desk-managed (read-only categories/channels);
  a customer-editable write path is a future seam.
- **Symbol brand derivative** (`happy-trader-symbol.png`) quarantined from shipping surfaces
  until a clean-edged source is supplied (faint frame artifact after keying) — see
  HAPPY_TRADER_BRAND_ASSET_MAP.md.

**Do not act on the above before the Portal V2 visual-acceptance phase.**

---

## Portal V2 — Human-Acceptance Review #3 (real product depth)

Documented seams carried from R3 (none faked in-product; each has a truthful state):
- **Support in the unauthenticated preview**: the vite-only dev preview has no backend/session, so
  the ticket list is empty and the New Request form surfaces the real server response. The surface is
  live-wired to `/api/v1/support`; authoritative create/lifecycle is proven by `support-http.test.ts`.
- **Certificate artwork in the dev review**: real renderer output shipped as samples (`cert-samples.ts`);
  production serves the customer's own via the authenticated endpoint. `EVALUATION_PASSED` / `HUNDREDK_CLUB`
  have no approved master → `DISABLED` (no sample), as the renderer reports.
- **Portfolio-P&L endpoint**: `V2PerfChart` is ready; the production cumulative-P&L projection endpoint
  is the seam the container fills.
- **Payment-method change / receipts**: provider-hosted flow + receipt endpoint remain seams (no fake).
- **Physical certificate commerce & Achievements**: still not surfaced in V2.
- **Future support chatbot**: documented seam only (not built).

**Do not act on the above before the Portal V2 visual-acceptance phase.**

## Experience Layer Phase 1 (EXP1) — Progress & motion

- **EXP1-1 (seam, deferred).** Portal V2 is the dev-review harness; the Progress page uses
  fixtures + local-state goal CRUD there. Production wiring of `V2ProgressPage` to
  `GET /api/v1/portal/progress` and `/goals` CRUD is built and server-tested but the
  production customer app (V1 portal) does not yet mount the V2 Progress surface.
- **EXP1-2 (deferred).** Number-roll transitions on live-updating financial values are not
  implemented (values render final + exact). Documented in PORTAL_V2_MOTION_SYSTEM.md.
- **EXP1-3 (deferred).** Achievement-unlock sound hook architecture is documented but no
  sound is implemented (no auto audio). No full-screen/blocking unlock UI.
- **EXP1-4 (deferred).** In-app notification center and the Progress nav "unseen
  achievement" dot are deferred (achievements carry a `viewedAt`-style capability in the
  reused backend but the indicator is not wired this phase).
- **EXP1-5 (owner dependency).** Owner-side visibility of the customer journey/clubs beyond
  existing achievement + payout-ops surfaces is deferred; no Owner Console changes made.
