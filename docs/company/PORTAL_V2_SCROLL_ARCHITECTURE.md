# Portal V2 — Scroll & Shell Architecture

**Portal V2 Scroll/Shell Hotfix** (base `1341eb1`). This exists so future frontend
work does not reintroduce the "content below the fold is unreachable" defect, and so
the review shell's routing and role-gating stay honest.

## Decision — ONE vertical scroll owner: the MAIN WORKSPACE

Portal V2 uses a single intentional scroll model: **the main workspace owns vertical
scrolling.** The document/body does NOT scroll. This matches the shell's application
layout (fixed sidebar + fixed top bar + scrolling workspace) and coexists with the
trading terminal, which locks the document globally.

Why not document/body scroll: the terminal's global `theme.css` sets
`html, body, #root { height: 100% }` and `body { overflow: hidden }` — a deliberate
viewport lock for the fixed full-screen terminal. Portal V2 renders inside that same
`#root`, so relying on page scroll would fight the lock (the original bug: overflowing
content was clipped and the wheel did nothing). Instead, Portal V2 binds its own root
to the viewport and scrolls the workspace inside it. No global `doc-scroll` class is
toggled (that mechanism, used by the Owner Console, is left untouched).

## Container hierarchy

```
#root                     theme.css: height:100%, (body) overflow:hidden   ← document locked
└ .htv2  (V2Root)         height:100dvh (100vh fallback); overflow:hidden  ← viewport-bound root
  └ .htv2-shell           display:grid; grid-template-columns: sidebar | 1fr;
                          grid-template-rows: minmax(0,1fr); height:100%; min-height:0
    ├ aside.htv2-side     min-height:0; overflow-y:auto                    ← sidebar scrolls independently
    └ .htv2-shell-main    display:flex; flex-direction:column; min-height:0; height:100%
      ├ header.htv2-top   fixed-height top bar (var(--ht-topbar-h))
      └ main.htv2-workspace  flex:1; min-height:0; overflow-y:auto; overflow-x:hidden  ← THE SCROLL OWNER
        └ .htv2-workspace-inner  max-width; centered; padding
```

The linchpins are **`min-height: 0`** on `.htv2-shell-main` and `.htv2-workspace`
(a flex/grid child defaults to `min-height: auto` and refuses to shrink below its
content, which would make the workspace grow to content height and never scroll) and
the **bounded grid row** `minmax(0, 1fr)` on `.htv2-shell` (so a tall page cannot
stretch the shell past the viewport).

## Behaviour

- **Desktop:** sidebar and top bar are visually stable; the workspace scrolls. Two
  columns, one bounded row.
- **Mobile (≤900px):** the sidebar becomes a top strip (`grid-template-rows: auto
  minmax(0,1fr)`, `overflow-x:auto` on the strip); the workspace (row 2) still owns
  vertical scroll.
- **Sidebar:** `min-height:0; overflow-y:auto` — a long sidebar scrolls on its own and
  never locks the shell or the workspace.
- **Top bar:** in normal flow inside the shell column; not `position: fixed`.
- **Short pages:** the workspace simply doesn't show a scrollbar (no forced empty
  scroll region, no nested blank pane).
- **Horizontal overflow:** prohibited at the page level (`overflow-x:hidden` on the
  workspace); internal wide tables use their own `.htv2-table-wrap { overflow-x:auto }`.
- **Modals/overlays:** because scroll ownership does not depend on `body` overflow, a
  modal that locks `body` and later restores it cannot break workspace scrolling
  (proven in the regression). Portal V2 does not leave a stale body lock.

## Review shell routing (dev only)

`/portal-v2` renders the dev **review shell** (`Review.tsx`), gated by
`designLabEnabled()` (a production build 404s). It routes its own sub-paths
client-side (pushState + popstate):

- `/portal-v2` → review dashboard landing
- `/portal-v2/accounts` → V2 Accounts (real presentational view, dev fixtures)
- `/portal-v2/accounts/:id` → V2 Account Detail with tabs (overview/performance/controls/rules/activity)
- `/portal-v2/dev/design-system` → the component design-system harness (dev-only)

Only destinations with a real V2 implementation appear in the sidebar (Dashboard,
Accounts, and the dev Design system). Payouts/Certificates/Achievements/Billing/
Support have no V2 implementation yet and are intentionally omitted rather than shown
as dead links.

## Role gating

Owner Console is **role-gated and off by default** — a normal customer never sees it
(not hidden with CSS, simply not rendered). It appears only on an explicit dev opt-in
(`/portal-v2?role=owner`) so the owner variant can be reviewed. This is UI only;
server-side authorization at `/admin` remains authoritative regardless.

## Regression

- `scripts/portal-v2-scroll.mjs` (`pnpm test:portal-v2-scroll`) — a REAL headless
  Chromium test that loads the actual global `theme.css` lock + the shell CSS inside a
  real `#root`, then at 1920×1080, 1440×900, 1280×720, 1024×768, 768×1024 and 390×844
  proves **actual movement** on the workspace (wheel, PageDown, programmatic), that the
  bottom sentinel is reachable, that the **document is not** the scroller, that there is
  no horizontal page overflow, and that a modal body lock/unlock does not break it.
- `apps/web/src/portal/v2/scroll-architecture.test.ts` — a fast vitest contract lock on
  the CSS declarations above and the review shell's honest nav + routing.

> Do NOT "fix" a future scroll problem with a page-specific `overflow` override, a
> magic viewport height, a spacer, or `!important`. Fix the ownership chain here.
