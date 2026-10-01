# Portal V2 — Experience Layer (Phase 1)

Additive layer over the existing (accepted) Portal V2 foundation. The portal was NOT
rebuilt. Two objectives: a coherent premium motion/aura system, and a new first-class
PROGRESS & ACHIEVEMENTS surface.

## Rose-gold / champagne aura system

Semantic tokens in `motion.css` (not per-component gold shades):
`--aura-champagne #e7dcc4`, `--aura-rose #e6c7bd`, `--aura-gold #d9c08a`,
`--aura-chrome #f5f4f1`, plus metallic text gradients.

- Metallic text: `.htv2-metal-champagne / -rose / -gold` (background-clip:text, solid
  fallbacks under `prefers-contrast: more`, `forced-colors`, print).
- Ambient aura: `.htv2-aura` + `.htv2-aura-on` (low-opacity radial "light hitting metal,"
  not a neon div). Disabled under reduced motion.

### Where aura is used (RARE, focal only)

Lifetime-paid value (Payouts hero, Progress hero, Dashboard journey strip), achieved
trader clubs (gold). Everything else stays black/graphite/warm-white/silver — the aura
reads because it is rare.

## Interactive surfaces touched

- Payment card — pointer tilt + light (see PORTAL_V2_MOTION_SYSTEM.md).
- Certificate tiles — `.htv2-lift`.
- Club cards, goal cards — `.htv2-lift`; achieved clubs get gold aura + metallic name.
- Buttons — premium press/lift via `.htv2-btn` augmentation.
- Progress hero + timeline nodes — `.htv2-enter` staggered entrance.

Not animated: financial history rows, support, profile, certificate text, account
economics.

## Progress & Achievements surface

- Nav: `progress` added between Certificates and Billing (`Shell.tsx`, `Review.tsx`).
- Page (`progress-page.tsx`): hero summary → journey TIMELINE (centerpiece; horizontal
  desktop, vertical mobile) → trader clubs → current focus → personal goals → accomplished.
- Timeline nodes: start (member since) → past milestones (achievements) → NOW → ahead
  (next club). Not a badge grid, not a game map.
- Goals: create/edit/complete(manual)/pin/archive via a dialog; MANUAL vs TRACKED.
- Dashboard integration: one restrained "Your journey" strip linking to Progress.
- Payouts integration: lifetime-paid hero already carries champagne + aura.

## Zero / rich state

Zero customer → truthful zeros, "Your journey starts here," goal creation available, no
clubs achieved. Rich history → timeline scrolls horizontally on desktop, stacks on mobile;
milestones stay prominent.

## Dev-review vs production

Portal V2 is the dev-review harness (`/portal-v2`, gated; prod 404s). The Progress page is
driven by fixtures there (`FIXTURE_PROGRESS` / `FIXTURE_PROGRESS_EMPTY`) and a local-state
goal container — the same pattern every other V2 surface uses. Production mounts
`V2ProgressPage` against the authoritative endpoints (`GET /api/v1/portal/progress`,
`/goals` CRUD). No fixture business data is imported by any production container.

## Deferred

Number-roll transitions on live data, achievement-unlock sound hooks, in-app notification
center, and owner-side journey visibility are documented as future work.
