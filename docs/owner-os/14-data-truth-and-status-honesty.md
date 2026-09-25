# Owner OS — Data Truth & Status Honesty (§107)

> Never present inferred, mock, or unconfigured state as verified reality.

This is a first-class design constraint of the Owner Operating System, not a nicety.
The console exists to let the owner make real decisions; a fake green is worse than
no signal at all.

## The four states of "is X working?"

The console distinguishes, and never collapses:

1. **Code installed** — the implementation exists in the codebase.
2. **Configured** — credentials / settings are present.
3. **Authenticated** — a real connection/handshake succeeded.
4. **Verified** — end-to-end behaviour was confirmed against reality.

A subsystem may be at stage 1 or 2 and the console says exactly that. It does not
imply stage 3 or 4.

## Where this shows up

- **Rithmic** (`system-doctor.ts`, `ops-io.ts`) — architecture exists from M9, but
  M9 did **not** complete a live Rithmic acceptance. The doctor and provider
  status report installed/configured truthfully and **never** mark Rithmic
  `connected` or `verified` from code alone.
- **Market data** (`ops-io.ts`) — the eight launch instruments are listed as
  `NOT_VERIFIED` until a real feed is confirmed.
- **Notification channels** (`alerts.ts`) — external channels report
  `NOT_CONFIGURED` when their credentials are absent; only `IN_APP` is configured.
- **Environment badge** (web header) — reads the server-authoritative
  `EXTERNAL_LIVE` gate and shows `SIMULATION` while it is off. `EXTERNAL_LIVE_ENABLED`
  remains `false`: nothing can place a real external order, move real money, or
  charge a real card.
- **Migrations** (`system-doctor.ts`) — verified by sentinel-table presence, not by
  the drifted drizzle tracker, so the "migrations healthy" signal reflects the
  actual schema.
- **Financial figures** (`financial-ops.ts`) — computed from source rows, never a
  stored total that could drift.

## How the UI honours it

The web renders `StatusPill` with exactly the server-reported status string. There
is no client-side "assume healthy". A `NOT_VERIFIED` / `NOT_CONFIGURED` status
renders in a muted, unmistakably-not-green tone. Provider rows print `verified: no`
plainly.

## Tested

`system-doctor.test.ts` asserts Rithmic is never fake-connected;
`ops-io-finance.test.ts` asserts provider Rithmic `verified === false` and the eight
instruments are `NOT_VERIFIED`; `alerts.test.ts` asserts external channels are
`NOT_CONFIGURED` when absent.
