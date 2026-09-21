# Market-data licensing gate

**This is the operational gate, not the research.** The full analysis lives in
`market-data-licensing.md` (obligations, per-subscriber fees, vendor positions)
and `market-data-provider-evaluation.md` (the Databento decision). This document
exists to do one thing: make it impossible to confuse **technical access** with
**commercial redistribution rights**, and to state exactly what Atlas is and is
not cleared to do at each stage.

> **Technical access ≠ redistribution rights.** `DATABENTO CONNECTED` is a
> transport fact. It says nothing about whether Atlas may show that data to
> anyone other than the developer holding the key.

Not legal advice. Every clearance below is either **VERIFIED** against a vendor's
current documentation or **REQUIRES CONFIRMATION** (vendor, exchange, or
counsel). Assume the unconfirmed is not permitted.

---

## 1. The five access categories

Atlas must reason about market-data rights in these distinct categories. They
are separate rights with separate fees; holding one never implies another.

| # | Category | What it means | Atlas status today |
| - | --- | --- | --- |
| 1 | **DEVELOPMENT ACCESS** | One developer, one key, building and validating the pipeline. Historical data, or live for internal engineering only. | **Intended target of this milestone.** Historical free credits + optionally one $199/mo live seat, used only by the server operator. |
| 2 | **INTERNAL DISPLAY** | Data shown on screens inside the operating company (e.g. the Owner Control Center to Atlas staff). | **Not cleared.** Owner reads derive from execution/account authority, not a direct market feed (see below). Treat operator screens as display use requiring entitlement before real-time. |
| 3 | **NON-DISPLAY** | Data consumed by machines, not shown to a human — Atlas's execution engine marking positions, risk evaluation, candle aggregation. Priced separately by CME and usually higher per-seat than non-professional display. | **REQUIRES CONFIRMATION.** Atlas's core use (marking, rules) is arguably non-display; this classification moves the fee materially and must be settled with the vendor/exchange. |
| 4 | **EXTERNAL DISTRIBUTION** | Showing prices to Atlas's *end users* (traders, prop-firm participants). This is the product. | **Not cleared for real-time.** Real-time external distribution requires an exchange ILA (months). Delayed by ≥24h is a lighter, separately-granted path — `market-data-licensing.md` §1. |
| 5 | **PER-USER / PER-DEVICE ENTITLEMENT** | The obligation to know, enforce, count and report each subscriber's entitlement (real-time / delayed / none), and their professional vs non-professional status. | **Not built.** The gateway broadcasts one stream to all clients. Per-user entitlement is an architectural change, deliberately deferred until there is an entitlement to enforce (`market-data-licensing.md` §4). |

---

## 2. What this milestone is cleared to do

- **VERIFIED (Databento pricing/licensing):** Build and validate the entire
  pipeline on **historical** data with free credits — no exchange conversation.
- **VERIFIED:** Purchase one **live** developer seat ($199/mo Standard) and use
  it for **internal engineering only** — never served to another user.
- Keep the delayed legacy provider available and honestly labelled.

## 3. What this milestone must NOT claim or do

- Must **not** serve real-time CME data to any end user.
- Must **not** interpret a working Databento connection as commercial clearance.
- Must **not** remove or weaken the honest `mode: DELAYED | REALTIME | REPLAY`
  labelling; a real-time badge is a compliance statement, not a UI choice.
- Must **not** replay recorded exchange data to end users — replay rights are
  separate and unconfirmed (`market-data-licensing.md` §5 item 7).

---

## 4. The production licensing guard (Phase 89)

To make the boundary enforceable rather than aspirational, provider selection
and redistribution posture are explicit, deliberate configuration — never
inferred from whether a key happens to exist:

- **`MARKET_DATA_PROVIDER`** selects the provider deliberately (`legacy` |
  `databento` | `replay`). A present `DATABENTO_API_KEY` does **not** silently
  switch Atlas to Databento (Phase 68).
- **`MARKET_DATA_REDISTRIBUTION`** (default `none`) is an explicit posture
  declaration: `none` | `internal` | `delayed-external` | `realtime-external`.
  Atlas ships with `none`. Anything above `none` must be backed by a real
  entitlement; the value is recorded in Owner System Health so an operator can
  see, at a glance, what posture the running server believes it holds.
- A provider's declared `mode` and the redistribution posture are surfaced,
  never hidden. A server configured `realtime-external` without the entitlement
  paperwork is a business/legal error the code cannot detect — so the guard's
  job is to make the claim **visible and deliberate**, not to certify it.

The guard does not grant rights. It ensures no developer can reach a state where
Atlas behaves as if it holds rights it has not actually been granted, without
having typed the claim in as configuration.

---

## 5. The questions that still gate external distribution

Unchanged from `market-data-licensing.md` §5; restated here as the gate items
that block category 4/5, none of which this milestone can resolve alone:

1. Subscriber status of simulated-account users (a CME determination).
2. Whether evaluation-fee-paying users change that status.
3. Per-user real-time fee for Atlas's expected mix at 10 / 100 / 1,000 users.
4. Whether a chosen vendor's packaging carries entitlement administration.
5. What "delayed" must mean technically to serve unentitled users.
6. Replay/storage rights for recorded exchange data.

Until these are answered in writing, Atlas holds category 1 only, and every
report says so.
