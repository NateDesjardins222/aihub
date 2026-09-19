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
  despite being written during the previous one. It has now been run, found
  D-007 about itself and D-008 about the product, and been fixed.
* D-008's open question: whether the terminal's six parallel reads should be
  atomic.
