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
* The execution torture harness (`tools/exec-torture.mjs`) had never been run
  when this milestone began, despite being written during the previous one.
  It is running now; whatever it finds lands here.
