# Atlas — deep diagnostics report

*Milestone: Stop building. Start breaking Atlas.*

This is the honest account of a milestone spent trying to break Atlas rather
than extend it. It does not say "all tests passed", because that is the least
useful sentence a report like this can contain. It says what was attacked, what
broke, why it broke, how it was fixed, which test now stands guard, what could
not be tested, and what still worries me.

The full per-defect detail — reproduction, root cause, fix, regression test,
commit — is in `docs/diagnostics-failure-ledger.md`, D-001 through D-017. This
report is the narrative and the numbers.

---

## 1. The one thing worth remembering

**The tests were lying, and the worst of them lied confidently.**

The execution torture harness had been written in the previous milestone and
never run. When it was finally run, it reported "0 invariant failures" for a
hundred operations — and it was reading *nothing*. Four parallel API reads
shared one single-use refresh token, three of the four failed, and the harness
turned each failure into "the account is flat", which satisfies every money
invariant it checks. A test that cannot fail is worse than no test: it is a
green light wired to nothing.

Of the seventeen numbered defects found this milestone, **seven were in the
code that does the testing** (D-004, D-007, D-009, D-010, D-012, D-015, D-017) and one was
a wrong invariant (D-011). That is the headline. Before this milestone, the
suites were partly measuring their own coincidences. They measure the product
now.

Two of the remaining findings are genuine, shipped product defects that a
trader would have hit — one of them severe:

* **D-016 (P0)** — a production server would boot and sign real sessions with
  the development secret that is printed in this repository. Forgeable auth.
* **D-013 (P1)** — reloading two browser tabs at once signed the trader out of
  both, mid-session, with positions open.

Both are fixed, both have regression tests, and D-016's fix was confirmed by
booting the built server and watching it refuse.

---

## 2. What we tried to break, and what happened

| Attack | Tool | Result |
| --- | --- | --- |
| Duplicate orders from a double click / three clicks in one task | `execution-safety` | **Broke (D-001)**, fixed: synchronous intent guard |
| One account's money painted under another's name during an account switch | `execution-safety` | **Broke (D-002)**, fixed: load-token guard on every write |
| Hundreds of random execution operations against six money invariants | `exec-torture` | Product holds; the **harness** broke four ways (D-007/9/10/12) and one invariant was wrong (D-011). All fixed. 240 ops, 183 with a position, 0 invariant failures. |
| A second user reading or mutating the first user's account | `diagnose-authorization` | Held. 25 attacks, all refused, victim unchanged to the micro-dollar. |
| Malformed, absurd and hostile request bodies; NaN/Infinity into every money route | `diagnose-fuzz` | **Broke once (D-006)** — malformed JSON was a 500. Fixed. 373 checks, 0 findings, nothing leaked. |
| Two tabs racing for one session | `diagnose-multitab` | **Broke (D-013)**, fixed: browser-wide refresh lock. 6/6. |
| Every stored preference corrupted, one at a time and all at once, plus storage that throws | `diagnose-chaos` | Held. 126 corrupted preferences + all-at-once + write-throwing storage all still start the terminal. |
| A reload and a dead network in the middle of an order | `diagnose-interrupt` | Held. The screen never disagreed with the server. 8/8. |
| A second server on a held port; SIGTERM mid-flight | `diagnose-lifecycle` | Held. Fails with EADDRINUSE rather than half-binding; SIGTERM exits clean and frees the port. 9/9. |
| Production booting on the development signing secret | production-build check | **Broke (D-016, P0)**, fixed: fail-fast in `env()`, confirmed end to end. |
| The account bar at every laptop width | `responsive` | **Broke (D-014)** — the balance was clipped at six widths. Fixed. 50/50. |
| The whole browser suite, in a shuffled order | `run.mjs --shuffle` | **Broke (D-017)** — 27 checks across 15 suites, two inherited-state causes. Fixed; all 35 suites now pass shuffled. |
| Ten deliberate code defects, to see whether the tests notice | `diagnose-mutations` | 10 of 12 caught; the two survivors are explained (one redundant guard, one covered by the browser suite and proved so). |

---

## 3. What actually broke, ranked

**P0 — one.**
* **D-016** Production would sign sessions with the public dev secret. Anyone
  who read the repo could forge a token for any user. Fixed: production refuses
  to boot on the default secret or a wildcard CORS origin.

**P1 — five (four of them in the tests).**
* **D-002** A late read could paint account A's money under account B's name. *(product)*
* **D-013** Two tabs reloaded together signed the trader out of both. *(product)*
* **D-009** The torture harness read "flat" when it could not read at all. *(test)*
* **D-011** The balance invariant was arithmetic the engine never performed. *(test)*
* **D-015** The suite traded into a market that was closed, then crashed six later suites. *(test)*
* **D-004, D-007** — earlier P1 test-integrity failures, fixed before this report.

**P2 — three.**
* **D-001** A double click sent two orders. *(product)*
* **D-006** Malformed JSON was reported as a 500. *(product)*
* **D-014** The account bar clipped the balance at laptop widths. *(product)*
* **D-005, D-010** — a renamed class that cost six suites; partials wrong-sided on a short. *(test)*

**P3 — two.**
* **D-008** The valuation and the positions can disagree for one refresh cycle. *(product, open question)*
* **D-012** The harness could not fill an order on a live feed. *(test)*

---

## 4. The numbers

* **Unit tests:** 42 files, 735 checks, all passing (the previous 728, plus 4 production-guard cases and 3 refresh-race cases).
* **Browser suites:** 35 suites, all passing — **in a shuffled order as well as the written one**. A first shuffle run (D-017) failed 27 checks across 15 suites; with the two inherited-state causes fixed, `run.mjs --shuffle --seed 4242` now reports all 35 suites passing. The only other failure seen this milestone was a self-inflicted API restart (I rebuilt the server mid-suite), which passes on a clean re-run.
* **Mutation testing:** 12 deliberate defects, 10 caught, 2 survivors both explained and one proved by the browser suite.
* **Torture:** 240 operations, all nine operation types, 183 with a position open, 0 refusals, 0 invariant failures, no page errors, DOM 352→382, heap stable.
* **Fuzz:** 373 hostile requests, 0 findings, nothing internal leaked, the account unchanged and the simulation environment restored.
* **Authorization:** 25 cross-account attacks, all refused.
* **Chaos:** 126 corrupted-storage starts + all-at-once + write-throwing storage, all recover.
* **Interrupt:** 8/8 — the screen never disagreed with the server.
* **Lifecycle:** 9/9 — no half-bind, no zombie, clean SIGTERM.
* **Typecheck & production build:** clean, no committed secrets in the bundle.

---

## 5. What could not be tested, and what was worked around

* **A genuinely live exchange.** The feed is a delayed one, and much of this
  work ran during the CME's afternoon maintenance break — which is itself how
  **D-015** was found. Order-entry paths are exercised against a paused
  recording, which the engine treats identically; what a real-time book would
  do differently (partial fills against depth) is not tested because this feed
  has no book, and the product correctly invents none.
* **Real provider credentials, live vendor responses, licensing.** Out of
  scope by instruction, and nothing was faked to stand in for them.
* **Level 2 / DOM, backtesting, alerts.** Explicitly not built this milestone.
* **A true multi-machine / multi-process race on the database.** Tested at the
  single-server level (the account mutex, the authorization boundary, the
  lifecycle collision); a horizontally scaled deployment is a different test
  rig than exists here.

---

## 6. What still worries me

1. **D-008 is open on purpose.** The account header reads six endpoints in
   parallel and can disagree with the blotter by one refresh cycle while a fill
   lands between two of the reads. It is small, it self-corrects, and it is
   exactly the class of thing this milestone exists to notice. Whether the
   terminal should read atomically is a real question I did not answer.
2. **DOM grew 30 nodes over 240 torture operations.** Canvases were stable and
   heap fell back, so this is not a leak on the face of it — but it is a slope,
   and a longer soak than 240 operations would say whether it plateaus.
3. **The tests were trusted for a whole milestone before being tested.** The
   discipline that found D-009 — run the test, then ask whether the test could
   actually fail — is now habit, but it is a habit, not a mechanism. The
   `--shuffle` runner and the mutation suite are the closest thing to a
   mechanism, and they are new.
4. **`navigator.locks` is not everywhere.** D-013's fix uses it where present
   and falls back to a narrower correct path where it is not. The fallback is
   unit-tested, but it is a second code path, and second code paths are where
   the next D-013 lives.

---

## 7. The standing arsenal

Every attack is a command, and every command reports what it could *not* run as
loudly as what failed:

```
pnpm diagnose                # everything, with a health-gated summary
pnpm diagnose:mutations      # do the tests catch anything?
pnpm diagnose:authorization  # a second user attacking the first
pnpm diagnose:fuzz           # hostile request bodies + numeric injection
pnpm diagnose:multitab       # two tabs racing for one session
pnpm diagnose:chaos          # corrupted localStorage
pnpm diagnose:interrupt      # reload / dead network mid-order
pnpm diagnose:lifecycle      # start/stop attacks
pnpm diagnose:torture        # the execution money invariants
node tests/browser/run.mjs --shuffle   # order-independence
```

These are the attacks worth repeating on every future change, and they now
exist as one word each.
