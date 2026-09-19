# Atlas — diagnostics failure ledger

Every meaningful failure found while deliberately trying to break Atlas. The
embarrassing ones are the point: a failure discovered here is one a trader does
not discover later.

**Severity**

| | |
| --- | --- |
| **P0** | financial, security or data-integrity catastrophe |
| **P1** | serious trading reliability |
| **P2** | meaningful workflow defect |
| **P3** | minor quality or polish |

Entries are numbered in the order they were found, not by severity.

---

## D-001 — A double click sent two orders

| | |
| --- | --- |
| **Severity** | P1 |
| **Found by** | reading `OrderTicket.submit` before changing it |
| **Symptom** | Two clicks on BUY created two real orders, so a trader who double-clicked took twice the position they asked for. |
| **Reproduction** | `page.dblclick('[data-testid=buy]')` with any quantity; count orders on the account afterwards. |
| **Root cause** | The server's idempotency is keyed on `clientOrderId`, and the ticket called `newClientOrderId('ticket')` on **every click** — so two clicks were two different keys and the server was right to create two orders. The only guard was a React `busy` flag, which is set asynchronously and cannot help two events dispatched in the same task. |
| **Fix** | `sendIntent` keys an intent (account + symbol + side + qty + type) into a module-level map, checked and claimed **synchronously before any await**. A press that finds its intent in flight joins the existing promise. A deliberate second press after acknowledgement is still a second order. |
| **Regression test** | `tests/browser/execution-safety.spec.mjs` — double click, three clicks dispatched in one task, and two deliberate presses (which must still be two orders). |
| **Commit** | `1f50406` |

## D-002 — A late read could paint one account's money under another's name

| | |
| --- | --- |
| **Severity** | P0 |
| **Found by** | reading `useTrading.readAll` |
| **Symptom** | Switching accounts while six authoritative reads were in flight wrote account A's orders, positions, trades, executions and P&L into a terminal showing account B — with nothing on screen to say so. |
| **Reproduction** | Hold `/api/v1/positions` for three seconds, switch accounts, wait for the held response. |
| **Root cause** | `readAll(accountId)` captured the id at the start and then `set(...)` the result **unconditionally**. The market-data path had solved this with a load token; the money path never got the same guard. |
| **Fix** | `readAll`, its error path, its loading flag and `refreshPnl` all check `get().accountId === accountId` before writing. |
| **Regression test** | `tests/browser/execution-safety.spec.mjs` — the positions read is deliberately held, the account is switched, and the terminal must show the new account. |
| **Commit** | `1f50406` |

## D-003 — Chart-side rejections were recorded and shown nowhere

| | |
| --- | --- |
| **Severity** | P2 |
| **Found by** | wiring readable rejection messages, and grepping for who displayed `lastRejection` |
| **Symptom** | Dragging a stop somewhere the engine refuses made the line spring back with no explanation. The refusal was stored in the trading store and rendered by nothing. |
| **Reproduction** | Drag a protective level to the wrong side of the market; observe the line return silently. |
| **Root cause** | `setRejection` was called; no component ever read `lastRejection`. |
| **Fix** | A quiet notice under the status line, carrying the readable reason, auto-dismissing after seven seconds — plus a `refresh()` in the catch so the chart returns to server truth rather than keeping the refused position. |
| **Regression test** | pending — see "open" below. |
| **Commit** | `1f50406` |

## D-004 — Five kinds of inherited state made the suite lie

| | |
| --- | --- |
| **Severity** | P1 (test integrity) |
| **Found by** | running the suites in a different order than usual |
| **Symptom** | Failures that looked like product defects: a stop painted the wrong red, panes at the wrong proportions, protection appearing "merely because bracket mode is on", a fib with no levels, drawings painted nowhere. |
| **Root cause** | Five separate pieces of state persist per account and were inherited by whichever suite ran next: the **theme** (a light-theme run left `drag-protect` reading Clean Light's red), the **execution defaults** (`bracketMode: AUTO` leaking into `terminal`), the **chart layout** (a suite that died holding four charts made `.chart-canvas` ambiguous and crashed five later suites under Playwright strict mode), the **chart symbol and timeframe** (drawing suites never declared one, so a fib drawn on inherited ES 5m fell outside the pixel scan), and **pixel-based drag distances** (120px is 40 ticks on a normal chart and 4 on a paused replay's six-point axis). |
| **Fix** | Sign-in restores a stated starting point: live provider, single chart, NQ at 1m, the default theme, the default execution defaults. `stress` seeds on the timeframe the chart is actually showing. `execution-interaction` expresses drags in ticks through the chart's own scale, clamped to a third of the visible height. |
| **Regression test** | The guards are in `tests/browser/harness.mjs` and run on every `signIn`. |
| **Commit** | `55eb881`, `6714257`, `2da6bb5` |

## D-005 — One renamed class cost six suites

| | |
| --- | --- |
| **Severity** | P2 (test integrity) |
| **Found by** | a full-suite run returning 29 suites instead of 35 |
| **Symptom** | `multi-chart` timed out after 30s, then five later suites threw immediately. |
| **Root cause** | A CSS class was renamed from `tk-contract` to `tk-head-contract` while folding the account into the contract row. `multi-chart` waited on the old selector, timed out **holding a four-chart layout**, and every later suite that used `.chart-canvas` hit Playwright's strict-mode error. |
| **Fix** | The class is back to what it names. Sign-in restores a single chart so no suite can cascade like that again. |
| **Regression test** | The layout guard in `harness.mjs`. |
| **Commit** | `6714257` |

## D-006 — Every malformed request body was reported as a server fault

| | |
| --- | --- |
| **Severity** | P2 |
| **Found by** | `tools/diagnose-fuzz.mjs` |
| **Symptom** | Any body that is not valid JSON — a truncated payload, a trailing comma, a bare newline, NUL bytes — came back as **HTTP 500 `INTERNAL_ERROR`, "Unexpected server error."** On every route, authenticated or not. |
| **Reproduction** | `curl -X POST localhost:4000/api/v1/auth/login -H 'content-type: application/json' -d '{"email":'` |
| **Root cause** | Atlas installs a **custom** `application/json` content-type parser so that an empty body can mean `{}`. On a parse failure it called `done(err)` with the raw `SyntaxError`, which carries no `statusCode` and no Fastify error code. The error handler's framework branch matches on `statusCode < 500`, could not match, and fell through to the 500. Fastify's own parser raises a `FastifyError` carrying 400 — confirmed by reproducing it in an isolated Fastify instance — and replacing that parser threw the typing away with it. A convenience cost the truth. |
| **Consequence** | Atlas reported a client's typo as its own failure, and would page whoever watches 5xx rates for it. No leak: the fuzzer's stack-trace, path, SQL and library checks all passed. |
| **Fix** | The parser now hands back `ApiError.badRequest('MALFORMED_JSON', …)`, which the error handler already maps. Empty bodies still read as `{}`; valid requests are unaffected. |
| **Regression test** | `tools/diagnose-fuzz.mjs` — five malformed-body cases, each judged for "no 5xx", "not accepted" and "nothing internal leaked". |
| **Commit** | see below |

## D-007 — The execution torture harness was testing almost nothing

| | |
| --- | --- |
| **Severity** | P1 (test integrity) |
| **Found by** | running it for the first time |
| **Symptom** | 250 operations reported as a torture test. The breakdown: 87 sells, 89 cancel-alls, 72 buys, 2 clear-stops. **Zero** partials, flattens, reverses, stops or targets — every one of which needs a position. |
| **Root cause** | Two compounding mistakes of mine. The harness stepped the paused replay four events and waited 220ms after each operation, which is not enough for a market order to fill, so a position almost never existed and every position-dependent operation was skipped. And the balance invariant compared the balance against `starting + every trade the API returns` — but `/trades` returns at most a page of the most recent, and this account has months of history, so the invariant could never be satisfied and reported a failure on the first sequence. An invariant that cannot pass trains you to ignore the output. |
| **Fix** | The harness now steps the replay until nothing is left working, so positions actually form. The balance invariant is a **delta**: between two snapshots the balance may only move by the net P&L of trades that appeared between them — which holds at any page size and is strictly stronger, because it catches a balance that moved for no reason at all. |
| **Regression test** | The harness is the test; it now exercises what it claimed to. |
| **Commit** | see below |

## D-008 — The valuation and the positions can disagree for a moment

| | |
| --- | --- |
| **Severity** | P3 |
| **Found by** | `tools/exec-torture.mjs` |
| **Symptom** | `/accounts/:id/pnl` reported 2 open contracts while `/positions` reported none. |
| **Root cause** | Not a defect. Both figures are computed from the same `positions` rows, and the P&L route recomputes the valuation on every request — so a disagreement means the two HTTP reads straddled a fill. The terminal's own `readAll` fetches all six endpoints in parallel, so the account header can briefly disagree with the blotter by one refresh. |
| **Fix** | None to the product. The harness now **re-reads before it accuses**, and counts a disagreement that corrects itself as read skew rather than a failure — the same discipline the performance gate needed. |
| **Still open** | Whether the terminal should read atomically. One refresh cycle of disagreement is small, but it is the class of thing this milestone exists to notice. |
| **Commit** | see below |

## D-009 — The torture harness read "no positions" when it could not read at all

| | |
| --- | --- |
| **Severity** | P1 (test integrity) |
| **Found by** | asking why 100 torture operations had chosen `buy`, `sell` and `cancel-all` and nothing else |
| **Symptom** | Six of the nine torture operations need an open position. Across several runs and hundreds of operations, **not one of them was ever chosen**: partial, flatten, reverse, stop, target and clear-stop were skipped every single time, and the harness reported "0 invariant failures" for a run that had only ever submitted and cancelled. |
| **Reproduction** | Call `apiFetch` four times in a `Promise.all` and print the results: one comes back with a body, three come back `null`. |
| **Root cause** | Refresh tokens are **single use** — `refresh()` revokes the presented token in the same `UPDATE ... WHERE revoked_at IS NULL RETURNING` that accepts it, which is correct and is exactly the reuse detection you want. The harness's `apiFetch` exchanged the stored refresh token **on every single call**. Four parallel reads therefore presented the same token four times: one won, three got `INVALID_REFRESH`, and the helper reported that as `null`. `read()` then did `positions?.body?.positions ?? []` — and a failed request became *"the account is flat"*. Every invariant in the file is satisfied by an account that is flat, so the run passed. **A read that did not happen is not a read of nothing.** |
| **Consequence** | Every execution torture run before this one proved almost nothing, and said so in the confident language of a passing test. This is the single worst result in the milestone, and it was in the test, not the product. |
| **Not a product defect** | The application's own client has always shared one in-flight refresh (`refreshInFlight` in `apps/web/src/api/client.ts`), so the terminal's six parallel reads never collided. The server's rotation is right and stays as it is. |
| **Fix** | `apiFetch` now shares one in-flight exchange per page, caches the access token, and only exchanges again on a real 401 — the same shape as the product's client. It never reports a failure as emptiness: a call that could not be made returns `{ ok: false, harnessError }`. `exec-torture.mjs`'s `read()` **throws** rather than defaulting to empty arrays. |
| **Regression test** | The harness reports `operations chosen with a position open: N`, and a run where that is zero is declared VACUOUS and exits non-zero. A silent return to this bug is now a failing run. |
| **Commit** | see below |

## D-010 — Every partial taken against a short scaled into it

| | |
| --- | --- |
| **Severity** | P2 (test integrity) |
| **Found by** | reading the torture operations again once they could finally run |
| **Symptom** | With D-009 fixed, the position-dependent operations ran for the first time — and three of them were wrong-sided on a short. |
| **Root cause** | The API presents a position with `qty` **absolute** and `signedQty` carrying the direction. The harness chose sides with `position.qty > 0`, which is true for a short as well. A partial on a short SOLD more; a stop on a short was placed below the market, where the target belongs; the target was placed where the stop belongs. Nothing failed: a scale-in is a legal order, and a refusal is a legitimate outcome, so the whole class of error was invisible. |
| **Fix** | Direction comes from `signedQty`, always, with a comment at the operation table saying why. |
| **Regression test** | The harness itself, which now exercises partials and protective levels on both sides. |
| **Commit** | see below |

## D-011 — The balance invariant was written from an assumption, not from the engine

| | |
| --- | --- |
| **Severity** | P1 (test integrity) |
| **Found by** | the first torture run that could open a position |
| **Symptom** | Two failures on the first two operations: *"balance moved -8070000 micros while 0 new trade(s) accounted for 0"*, and *"balance moved 261930000 while 1 new trade accounted for 253860000"*. Neither was a product defect. |
| **Root cause** | The invariant said the balance may only move by the net P&L of trades that closed. **Commission is charged at every fill, including the fill that opens a position** — and an opening fill closes no trade. The -$8.07 was three contracts of NQ entry commission, and the $8.07 discrepancy on the flatten was the same money, already debited at entry and therefore not owed again at exit. The invariant had been written from what the harness assumed the engine did rather than from what it does: `balance += realizedPnl - fees`, in one statement, on every fill. |
| **Fix** | Two invariants, from the engine's own rule. **The ledger agrees with itself**: the balance moved by exactly the realized P&L booked less the commission booked — so a balance that moves for any other reason is caught, however small. **The trades explain the realized P&L**: every micro-dollar of realized change is accounted for by trade rows a trader can see. Together they are strictly stronger than the version they replace, and they can actually be satisfied. |
| **Regression test** | Both run after every torture operation. |
| **Commit** | see below |

## D-012 — The torture harness could not trade a live market

| | |
| --- | --- |
| **Severity** | P3 (test integrity) |
| **Found by** | a run that happened to start while the exchange was open |
| **Symptom** | With a live feed the harness waited 220ms for a market order to fill, and every order sat WORKING — so positions never formed, for a completely different reason than D-009. |
| **Root cause** | The fill wait only existed for the replay branch: a paused recording needs pushing, and the code assumed that was the only case that needed waiting. A live delayed feed prints every few seconds, which is longer than 220ms. |
| **Fix** | The wait is now unconditional and mode-aware: step the recording when replaying, simply wait when live, in both cases until no MARKET order is left working. |
| **Commit** | see below |

## D-013 — Reloading two tabs at once signed the trader out of both

| | |
| --- | --- |
| **Severity** | P1 |
| **Found by** | `tools/diagnose-multitab.mjs`, written because D-009 raised the question |
| **Symptom** | Two tabs of Atlas, both signed in. Reload them at the same moment and the session is gone — from one tab, and usually from both. Measured before the fix: **three of four rounds lost the session**, twice signing out *both* tabs, after which neither could read the account. |
| **Reproduction** | `node tools/diagnose-multitab.mjs` — one browser context, two pages, `Promise.all([a.reload(), b.reload()])`, four times. |
| **Root cause** | The access token lives in memory, so a reloaded tab must exchange the stored refresh token before it can read anything. Refresh tokens are single use. Two tabs reloading together present the same token: one wins, one gets a 401. The losing tab then did what a 401 on refresh had always meant — `setRefreshToken(null)` — and **localStorage is shared between tabs**, so it deleted the token the winning tab had just stored. The winner survived until its own next refresh, and then it was gone too. Inside a single tab this could never happen: `refreshInFlight` shares one attempt. Nothing coordinated two tabs. |
| **Consequence** | A trader with a chart in one window and the journal in another, reloading after a deploy or a network blink, is thrown back to the sign-in form — with positions open. |
| **Fix** | `navigator.locks.request('atlas.auth.refresh', …)` serialises the exchange browser-wide, and **the token is read inside the lock**, so a tab that waited simply uses whatever the tab ahead of it stored. Where the Lock API is missing the fallback is narrower but still correct: a failed exchange clears the session only if storage still holds the token that failed; a different token there means another tab won, and that one is tried instead. A refresh that could not be sent at all — a dropped connection — no longer clears anything, because a network blink is not a revoked token. The server's rotation and its reuse detection are untouched. |
| **Regression test** | `apps/web/src/api/client.test.ts`, three cases (adopt the winner's token, sign out only when the stored token is the one that failed, survive a network failure), plus `tools/diagnose-multitab.mjs` at 6/6. Both new cases are proved by mutation: `cross-tab-refresh` and `refresh-network-failure` are CAUGHT. |
| **Commit** | see below |

## D-014 — The account bar clipped the trader's own balance

| | |
| --- | --- |
| **Severity** | P2 |
| **Found by** | the `responsive` suite, on the first full run of this milestone |
| **Symptom** | At **1440, 1366, 1280, 1152, 1024 and 900 pixels** the four figure boxes were narrower than the figures inside them: 137px of `$100,000.00` in a 134px box at 1280, and 121px in an 86px box at 1024. The balance was cut off mid-number. The indicator-legend and two-chart checks failed for the same reason at the same widths. |
| **Reproduction** | `node tests/browser/responsive.spec.mjs` — 16 failures, every one of them the account bar. |
| **Root cause** | `.abar` is a flex row and every child of it sets `white-space: nowrap`. Flex items shrink by default, so a crowded bar did not wrap the text — it **clipped** it. Nothing in the bar declared what may give way when there is not enough room, so everything gave way equally, including the numbers. |
| **Consequence** | Invisible in a maximised window, which is where the work was done, and present on every laptop screen. A settled balance that reads `$100,000.0` is not a small visual defect. |
| **Fix** | `.abar > * { flex: 0 0 auto }` — nothing in the bar shrinks below what it says. The account select is the single exception (`flex: 0 1 auto; min-width: 84px`), because a shortened account **name** is still the name the trader chose, and a shortened **balance** is a different number. |
| **Regression test** | `responsive` at 50/50, including 900x680 and the two-chart layouts. |
| **Commit** | see below |

## D-015 — The suite asked one of the two gates that stand in front of an order

| | |
| --- | --- |
| **Severity** | P1 (test integrity) |
| **Found by** | `terminal` failing "a market order opens a position" and then dying on a 30s timeout, taking six later suites with it |
| **Symptom** | `terminal` could not open a position, then timed out clicking a disabled Close button, crashed, and left the browser state that made `remaining-tools` report 33/51, `position-tools` 26/30, `indicators` 32/37 and four more suites short. **56 of the run's 59 failed checks came from this one failure**; `remaining-tools` scores 56/56 on its own. |
| **Root cause** | Two independent gates stand between an order and a fill. **Freshness** answers "how long ago did an observation arrive"; the **market era** answers "is this instrument trading at all". `tradableMarket` consulted only freshness. At 16:09 Chicago — inside the CME's daily maintenance break — the last print was minutes old, so freshness said FRESH and `blocksOrderEntry: false`, while the era said CLOSED and the engine refused with *"Market closed — NQ is closed: the feed stopped updating at the session break."* The helper reported a live market and the suite traded into a shut one. It passed all morning and failed for one hour every afternoon, which is precisely the failure shape that gets called flaky and ignored. |
| **Second cause, found on the way** | A click is not a request. `page.click` returns once the event is dispatched; the POST it starts is still in flight. The replay was nudged once, immediately — the market moved, the order arrived a moment later, and nothing else ever happened. The order sat WORKING and the suite reported "No active position" as though the product had dropped it. |
| **Fix** | `tradableMarket` blocks on either gate, so anything other than an open market goes to the recording. `nudgeRecording` steps the recording in rounds over a couple of seconds, after a pause that lets an in-flight submit land. |
| **Regression test** | `terminal` 21/21 and `responsive` 50/50 at an hour when the exchange is shut. |
| **Commit** | see below |

## D-016 — Production would boot with a public, forgeable signing secret

| | |
| --- | --- |
| **Severity** | P0 |
| **Found by** | the production-build check — grepping the config for what a real deploy would carry |
| **Symptom** | `JWT_SECRET` has a working default in the schema — `dev-only-insecure-secret-change-me` — so the project clones and runs. Nothing stopped a **production** server from booting on it. A server that signs real sessions with a secret printed in this repository can have its access tokens forged by anyone who has read the source: mint a token for any user id and the API cannot tell it from a real one. `CORS_ORIGIN` defaulting to `*` is the same class of thing, one notch down. |
| **Reproduction** | `NODE_ENV=production JWT_SECRET=dev-only-insecure-secret-change-me pnpm --filter @atlas/server start` — before the fix, it listened. |
| **Root cause** | A default that is safe only because nobody has deployed it yet. Convenient in development, catastrophic the first time it reaches production, and nothing in between said no. |
| **Fix** | `env()` fails fast in production: with the built-in JWT secret, or a wildcard CORS origin, it prints `FATAL: …` naming the variable and the fix and exits `78` (EX_CONFIG) before the process listens. Development is untouched — the defaults still work, which is their whole point. The check is a pure function, `productionMisconfiguration`, so it is tested without exiting the test runner. |
| **Verified end to end** | Booting the server with `NODE_ENV=production` and the default secret prints the FATAL line and refuses to listen. |
| **Regression test** | `apps/server/src/config/env.test.ts` — four cases: the insecure secret and the wildcard origin are both refused in production, a properly configured production server boots, and development is left alone with the defaults. |
| **Commit** | see below |

## D-017 — The suites were not order-independent, and a shuffle proved it

| | |
| --- | --- |
| **Severity** | P1 (test integrity) |
| **Found by** | `node tests/browser/run.mjs --shuffle` — running the suites in a dealt order rather than the one they were written in |
| **Symptom** | In the fixed order, 34 of 35 suites passed (the 35th a self-inflicted API restart). Dealt a random order, **27 checks failed across 15 suites**, and — the tell — several failed **run in isolation too**, which meant the fixed order had been hiding real coupling, not creating it. |
| **Root causes, two** | **(a) Account litter the market could not sweep.** Sign-in's `returnToLive` switches the market provider, which the engine refuses while a position is open (`OPEN_POSITION_BLOCKS_SWITCH`, HTTP 400 — correct). A suite that died holding a position left that 400 in the console, and the next suite failed its own "no page errors" check on it. Worse, the position could not always be flattened: the engine will not fill a market order into a CLOSED session era, so a position left open while the exchange was trading became un-closeable once it shut. **(b) Inherited chart style.** The style button's tooltip is the current style's name; `drawing-engine` switches to Bars and waited, in a later step, on `.chdr-icon[title="Candles"]` — which no longer existed once the style was Bars. Run cold, it timed out on its own leftover. |
| **Fix** | `returnToLive` now clears open positions **before** switching, so the refused 400 never happens, and falls back to the account's administrative **reset** when a closed market makes a position un-flattenable — the right tool for a test account's litter. `returnToDefaultChart` resets the chart style to Candles, the same way it already reset the symbol and timeframe. |
| **Regression test** | `drawing-engine` passes 36/36 run cold and run twice back to back; the `--shuffle` runner exists so this class is caught deliberately rather than by luck. |
| **Note** | This is the same lesson as D-004, one layer deeper: five kinds of inherited state were found then, two more here. The suites now reset symbol, timeframe, **style**, theme, execution defaults, layout, live-vs-replay, and any open position, at every sign-in. |
| **Commit** | see below |

---

## Testing the tests — twelve deliberate defects

`tools/diagnose-mutations.mjs` breaks the real source on purpose, twelve times over, runs the
tests that should notice, and **always restores the file** (`try/finally`, with
the touched paths verified clean at the end). No intentionally broken code is
committed; the mutations live as data in the script.

| mutation | what it breaks | result |
| --- | --- | --- |
| `fee-accumulation` | fills stop accumulating commission onto the position | CAUGHT |
| `tick-value` | NQ's tick value is doubled | CAUGHT |
| `position-side` | a negative quantity no longer reads as SHORT | CAUGHT |
| `average-entry` | scaling in ignores the new fill when averaging | CAUGHT |
| `break-even-rounding` | break-even rounds down, leaving the trader short of the fees | CAUGHT |
| `partial-whole-position` | a partial is allowed to close the whole position | CAUGHT |
| `audio-on-partial` | every partial fill announces "order filled" | CAUGHT |
| `position-readout-points` | the position tool reports ticks where it should report points | CAUGHT |
| `cross-tab-refresh` | the loser of a refresh race stops adopting the winner's token | CAUGHT |
| `refresh-network-failure` | a dropped connection during refresh signs the trader out | CAUGHT |
| `audio-on-first-read` | the first authoritative read replays every old fill out loud | SURVIVED |
| `stale-account-guard` | a late read is written to whatever account is on screen | SURVIVED — by design |

**`audio-on-first-read` survived, and the guard is redundant.** Removing
`if (previous.orders.size === 0 && previous.positions.size === 0) return [];`
from `soundsFor` failed nothing. That is not a missing test: with an empty
previous snapshot, the rule that unknown orders are not new events
(`if (before === undefined) continue;`) and the rule that a position must have
been non-zero before it can be reported closed already return `[]` on their
own. The guard states the intent at the top of the function, where a reader
looks, and the two rules beneath it enforce it. Both are kept: the comment is
worth the line.

**`stale-account-guard` survived the unit tests, and the claim was checked
rather than asserted.** The note in the script said "no unit test covers this;
the browser suite does". That is the kind of note that is comfortable to write
and expensive to be wrong about, so the mutation was applied to
`apps/web/src/trading/store.ts`, the web app rebuilt, and `execution-safety`
run against it:

```
FAIL  a double click on BUY sends ONE order                       — 3 order(s) created
FAIL  three clicks dispatched in one task send ONE order          — 2 order(s) created
FAIL  two deliberate presses are still two orders                 — 5 order(s) created
FAIL  and the position carries both                               — 1 contract(s)
FAIL  account A holds a position                                  — 0 contract(s)
execution-safety: 11/16 passed
```

Five failures. The guard is covered. The file was restored from its backup and
rebuilt before anything was committed.

---

## Attempted and held

Recorded because "we tried to break it and could not" is a result worth having,
and because these are the attacks worth repeating on every future change.

| what was attempted | result |
| --- | --- |
| A freshly registered second user reading another user's orders, positions, trades, executions, P&L, rules and environment | refused, HTTP 404 — existence is not even leaked |
| That user submitting, cancelling, flattening, reversing, protecting, resetting, rewriting rules and rewriting the simulation environment on another user's account | refused, HTTP 404 |
| Any of the above with no token | refused, HTTP 401 |
| A malformed token, an empty token, and an `alg: none` forged token | refused, HTTP 401 |
| The victim's balance and order book after all of it | unchanged, to the micro-dollar |

`tools/diagnose-authorization.mjs`, 25 checks, all passing.

---

## Open, and honestly open

* **D-003 has no regression test yet.** The fix is in; nothing proves it stays.
* The execution torture harness had never been run when this milestone began,
  despite being written during the previous one. Running it found four defects
  in the harness itself (D-007, D-009, D-010, D-012), one wrong invariant
  (D-011) and one question about the product (D-008). Five of the six findings
  were in the thing doing the testing. That ratio is the lesson of the
  milestone so far.
* D-008's open question: whether the terminal's six parallel reads should be
  atomic.
* Two tabs *were* tested against refresh-token rotation, because D-009 raised
  the question. They failed: D-013, now fixed and covered.
* **The previous milestone was pushed without a full browser run.** D-014 was
  waiting in `responsive` the whole time, and D-015 made the first run of this
  milestone report 59 failures of which 56 were one suite's crash. A full run
  is now the last step before a push, not an optional one.
