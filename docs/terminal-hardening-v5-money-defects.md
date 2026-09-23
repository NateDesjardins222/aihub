# Atlas — Terminal Hardening V5 — money defects

**P0: the money on screen must always be real.** The trader reported a phantom
≈ +$8,000 on *another account* and stale figures. Prior work (V3) fixed the
server-side garbage-mark holes behind the −$45,000; V5 finds the **client-side**
class those didn't cover: a stale or wrong-account money response reaching the
screen.

Starting commit for V5: `ac12292`. Branch `claude/futures-trading-simulator-v8qefu`.

## Where the money comes from (client)

```
server AccountValuation {at, seq, balance, equity, openPnl, rules, …}
  → WS  acct.<id>.pnl   (whole valuation frame)      apps/web/src/trading/store.ts
  → REST /accounts/:id/{pnl,rules,environment}       apps/web/src/trading/api.ts
        ↓ (zustand)
  useTrading store: { accountId, pnl, rules, ruleBook, positions }   store.ts
        ↓
  AccountBar (BAL/RP&L/UP&L/MLL)   RiskPanel (EQ/BAL/OPEN/DAY/DD/DLL/target)
```

The client is a replica of server figures; the account's `seq` is the server's
monotonic per-account version, carried on every valuation (WS and REST).

## Root-cause class: stale / cross-account writes (fixed)

| # | Defect | File (pre-fix) | Symptom | Fix |
| --- | --- | --- | --- | --- |
| C-1 | `loadRules()` wrote the rule book (equity floor, drawdown, status = account money) with **no account re-check after the await** | store.ts `loadRules` | Switch A→B while `rules(A)` is in flight → A's response paints **B's** Risk panel + AccountBar status/MLL. **Best fit for "+$8,000 on another account after switching."** | Re-check `get().accountId !== accountId` after the await; drop the late response. |
| C-2 | `loadEnvironment()` — same unguarded late-write | store.ts `loadEnvironment` | A's environment paints B (same class; not money but same bug) | Same account guard. |
| C-3 | `readAll()` wrote the REST `pnl` snapshot with **no monotonic guard** | store.ts `readAll` | A slow REST `/pnl` (older `seq`) overwrites a newer WS-merged P&L → a stale figure resurrected **without any account switch** (a plausible phantom) | Gate the `pnl` write on the shared `lastPnlSeq` cursor; apply only when `pnl.seq >= lastPnlSeq`. |
| C-4 | `refreshPnl()` — same missing monotonic guard | store.ts `refreshPnl` | same as C-3 on the lighter refresh path | Same `seq` gate. |
| C-5 | WS monotonic guard keyed on `at` (timestamp) while the authoritative DTO version is `seq` | store.ts WS handler + pnl-merge | two different ordering keys → guard could desync; `balanceMicros` used loose `??` | Unify the guard on **`seq`** for WS and REST alike; `pnl-merge` applies `balanceMicros` by the same carried-vs-omitted rule as the null-honest fields. |

The cross-account guard pattern already existed for `readAll`/`refreshPnl`
(the `accountId` re-check); C-1/C-2 simply lacked it, and no path gated the
REST `pnl` write on `seq`. One monotonic authority (`seq`) now governs every
money write; `attach()` resets it to `-1` per account.

## Money invariants held

- Older money (lower `seq`) can never overwrite newer money, on ANY path
  (WS frame, `readAll`, `refreshPnl`).
- A response for account A can never write account B's displayed state
  (`accountId` re-check after every await, on every money path).
- `null` (UNKNOWN / cannot-be-priced) still propagates — no phantom `$0`
  (unchanged `pnl-merge` null-honesty, now including balance).

## Verification (deterministic, no browser)

`apps/web/src/trading/money-state-race.test.ts` — 4/4:
1. a stale REST pnl (older seq, huge figure) never overwrites a newer live figure;
2. a newer REST pnl applies, then an older WS frame is dropped;
3. Account A's late `loadRules` never paints Account B (the +$8k bleed);
4. a WS frame for A is dropped once B is selected.
`pnl-merge.test.ts` 4/4; web trading suite 8/8; web typecheck clean.

## Honest status / still to do

- The **server-side** −$45k data-layer fix (re-anchor during open market;
  mid-only/crossed-book bypass) shipped in V3 (`terminal-quality-v3-money-audit.md`)
  and stands. This V5 doc adds the client bleed/stale class.
- Not yet done this pass: the live multi-tab and reconnect-replay reproductions
  in the real browser (the container's Playwright is being killed this session),
  the money **torture** harness (§9), and the server-side equity/realized
  invariant assertions (§7). These are the next V5 steps; they are not claimed
  as done.
