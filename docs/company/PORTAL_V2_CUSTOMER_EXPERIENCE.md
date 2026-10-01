# Portal V2 — Customer Experience

How the portal is organised around real customer jobs, and the design posture (private
banking + professional trading terminal + institutional brokerage + Happy Trader brand).

## Information architecture

Primary nav (sidebar) — only destinations with a real implementation, no dead links:
**Dashboard · Accounts · Payouts · Certificates · Billing · Support.**

Utility surface (account menu, top-right, not primary nav):
**Profile & security** (the account center), **Owner Console** (owner-only, dev `?role=owner`),
**Sign out**. Owner Console is never in customer nav.

## Jobs-to-be-done → surface

| The customer wants to… | Surface |
|---|---|
| see where they stand at a glance | Dashboard (stat strip, attention row, top accounts, portfolio chart, recent activity) |
| manage/inspect an account | Accounts master/detail + Account detail tabs |
| withdraw / track profit | Payouts (premium hero + standing + history) |
| get their proof of achievement | Certificates (categorised vault, download, verify) |
| buy another account / manage payment | Billing (Add account, payment method, orders) |
| change their name/security/alerts | Profile & account center |
| get help | Support |

## Design posture
- **Geometry:** sharp, institutional. Radii 0–4px (`--ht-radius-*`). No pill/card-soup.
- **Surfaces:** layered near-black (`--ht-bg` → `--ht-surface-2`); 1px borders do the
  structural work; shadow is a whisper, never a SaaS drop.
- **Accent:** champagne for premium emphasis; a quiet silver interactive accent; semantic
  green/red/amber carry meaning only.
- **Status:** a dot + quiet uppercase micro-label (`.htv2-status`) — never a saturated
  component-library pill (this was an explicit rejection).
- **Density/typography:** dense pro spacing; tabular numerals (`.ht-num`) for all money.
- **Flatness over cards:** sections + hairline rules + ledger tables + the horizontal stat
  strip (the deliberate anti-"four giant stat cards").

## Anti-patterns banned
Gambling mechanics (streak meters, confetti, chance), fake charts, demo data for new
customers, dead buttons, engineering/dev language in customer view, Owner Console in nav.

## Responsive
Verified intent at 1920 / 1440 / 1280 / 1024 / 768 / 390. The workspace is the single
vertical scroll owner (see PORTAL_V2_SCROLL_ARCHITECTURE.md); no horizontal document
overflow. Sidebar collapses to a horizontal strip under 900px.

## Accessibility
Tabs use `role="tab"`/`aria-selected`; progress bars expose `aria-valuenow`; the area chart
carries `role="img"` + `aria-label`; focus-visible rings on all controls; status color is
paired with text, never color-only.
