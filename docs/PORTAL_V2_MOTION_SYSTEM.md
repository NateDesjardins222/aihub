# Portal V2 — Motion System

One coherent motion language, scoped under `.htv2`, centralized in
`apps/web/src/portal/v2/motion.css` (imported by `primitives.tsx`). Rule: **motion on
interaction, calm at rest.** Nothing moves on its own.

## Tokens

Durations: `--motion-instant 70ms`, `--motion-fast 120ms`, `--motion-standard 200ms`,
`--motion-emphasis 320ms`.

Easing (premium, no bounce/overshoot): `--motion-ease` (decel),
`--motion-ease-out` (soft settle), `--motion-ease-in`.

Interaction magnitudes (restrained): `--motion-lift -1px`, `--motion-lift-lg -2px`,
`--motion-press 0.5px`, `--motion-tilt-max 3deg`.

## Classes

- `.htv2-lift` — hover raise + press settle (opt-in; not every rectangle). Used on
  certificate tiles, club cards, goal cards.
- `.htv2-btn` press/lift augmentation — primary lifts on hover, all press on active.
- `.htv2-enter` — one-shot entrance (opacity + 6px translate), stagger via inline `--i`.
  Used on Progress hero, timeline nodes.
- `.htv2-unlock` — muted → metallic resolve, reserved for a real achievement unlock.
- `.htv2-tilt` + `.htv2-tilt-light` — pointer tilt surface (payment card), see below.

## Performance

Only `transform`/`opacity` animate — no layout thrash. The tilt (`tilt.ts`,
`useTilt`) is rAF-throttled and mutates CSS vars directly (`--rx/--ry/--lx/--ly`) so a
mousemove never triggers a React rerender.

## prefers-reduced-motion (MANDATORY)

A `@media (prefers-reduced-motion: reduce)` block collapses all transitions/animations to
~0.001ms, disables lift/tilt transforms, and forces aura opacity 0 and entrance/unlock to
their final state. Functionality is identical. Verified in `scripts/portal-v2-review.mjs`.

## Touch

`@media (hover: none)`: no tilt (`transform: none`), lift replaced by a small press-scale.
`useTilt` also no-ops on `pointerType === 'touch'`.

## Payment-card tilt (§7 of spec)

`useTilt(3)` → ±3° `rotateX/rotateY` following pointer, `perspective(900px)`, smooth
return-to-neutral via CSS transition on `onPointerLeave`. A restrained `--aura-chrome`
radial highlight follows the pointer (`mix-blend-mode: screen`, opacity gated by
`--tilt-active`). No glare, hologram, or neon. Applied via `PaymentCardFace` in both the
inline billing card and the manage modal.
