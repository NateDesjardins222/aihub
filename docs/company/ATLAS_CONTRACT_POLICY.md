# ATLAS CONTRACT POLICY

**Engineering Phase A, STEP 10.** What contract each Atlas symbol actually represents today (dev) and
the policy for a future production provider. This is the single largest reason Atlas candles can look
different from a reference platform, so it is stated explicitly rather than "fixed" by shifting data.

## Development (current): Yahoo continuous front-month

The dev provider (`YahooDelayedProvider`) maps every Atlas root to a Yahoo `=F` ticker, which is
Yahoo's **continuous front-month** futures series (auto-rolls to the near contract; not a specific
month code, and not back-adjusted in any way Atlas controls).

| Atlas symbol | Provider symbol | Contract | Continuous? | Front month? | Exchange | Tick size | Point value | Session |
|---|---|---|---|---|---|---|---|---|
| NQ  | `NQ=F` | continuous | yes | yes | CME | 0.25 | $20/pt | Globex (CT) |
| MNQ | `NQ=F` | continuous | yes | yes | CME | 0.25 | $2/pt | Globex (CT) |
| ES  | `ES=F` | continuous | yes | yes | CME | 0.25 | $50/pt | Globex (CT) |
| MES | `ES=F` | continuous | yes | yes | CME | 0.25 | $5/pt | Globex (CT) |
| GC  | `GC=F` | continuous | yes | yes | COMEX | 0.10 | $100/pt | Globex (CT) |
| MGC | `GC=F` | continuous | yes | yes | COMEX | 0.10 | $10/pt | Globex (CT) |
| CL  | `CL=F` | continuous | yes | yes | NYMEX | 0.01 | $1000/pt | Globex (CT) |
| MCL | `CL=F` | continuous | yes | yes | NYMEX | 0.01 | $100/pt | Globex (CT) |

Tick size / point value / session come from `packages/instruments/src/registry.ts`; the vendor mapping
from `spec.providerSymbols['yahoo']`.

### Consequences to understand (not defects)

1. **Micros share the mini series.** MNQ shows `NQ=F` (E-mini Nasdaq) bars, not the micro's own
   prints. Chart shape and price are correct for the underlying; the *contract-specific* prints and
   volume of the micro are not independently sourced. Tick/point value differ per the table, so P&L
   is correct; the candles are the mini's.
2. **Continuous vs a specific contract.** A reference platform showing a specific contract month (e.g.
   `NQZ25`) or a *back-adjusted* continuous series will legitimately show different opens/closes and a
   price **jump at each roll**. Atlas's `=F` is a non-adjusted front-month stitch, so roll boundaries
   can look like a "gap" or a sudden jump. This is genuine rollover, not a bug — do not shift data to
   hide it.
3. **Roll timing is the vendor's.** Yahoo decides when `=F` rolls (typically volume/OI driven near
   expiry). Atlas does not stitch or back-adjust; it shows exactly what the vendor's continuous series
   contains.

## Production policy (future provider)

When `MARKET_DATA_PROVIDER=databento` (dataset default `GLBX.MDP3`) or `rithmic`:

- Prefer the exchange-native **front-month by open interest / volume**, or an explicitly defined
  continuous rule, and **record which** in the provider adapter.
- If a continuous series is used, state whether it is **back-adjusted**; never mix adjusted and
  unadjusted history silently.
- Never stitch two contract months into one series without recording the roll boundary; a roll must be
  attributable, not an unexplained jump.
- Micro symbols should map to their **own** contract where the provider supplies it, so micro prints
  and volume are independent of the mini.

Until a production provider is licensed and configured, the dev policy above stands and every chart is
Yahoo continuous front-month. **No real provider / production Rithmic / real money is in scope now.**
