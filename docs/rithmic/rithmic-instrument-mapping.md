# Rithmic Instrument Mapping (Milestone 9)

Launch instruments: **NQ, MNQ, ES, MES, GC, MGC, CL, MCL**.

## Canonical authority
Atlas's `@atlas/instruments` registry stays canonical for tick size, point value
and risk economics. `domain/instruments.ts` exposes `atlasCanonical(root)` and
`rithmicExchange(root)` (CME for NQ/MNQ/ES/MES, COMEX for GC/MGC, NYMEX for
CL/MCL) — from the registry, not guessed, so NQ/ES/GC/CL never inherit identical
economics.

## Reference-data reconciliation
`reconcileReferenceData(root, providerRef)` compares Rithmic `ResponseReferenceData`
(tick size, point value, exchange, tradable) against Atlas canonical →
MATCHED / DISCREPANCY / INCOMPLETE. Atlas is **never overwritten**; a mismatch
(including an exchange mismatch or a non-tradable/synthetic instrument) is surfaced.

## Contracts / rollover
The active/front contract is **not guessed** — the authoritative Rithmic trading
symbol comes from reference discovery at runtime (§11). Atlas provides a candidate
from its own contract resolver; unavailable / stale / expired / exchange-mismatch
cases are handled explicitly and unrelated contracts are never stitched together.
