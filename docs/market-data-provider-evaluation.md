# Professional market data: provider evaluation

Researched September 2026. Every factual claim below carries its source and a
confidence label. Where a term could not be confirmed from the vendor's own
current documentation it says **REQUIRES VENDOR CONFIRMATION** rather than
guessing, because getting licensing wrong is the kind of mistake that ends a
platform rather than delays one.

Three labels are used:

* **VERIFIED** — read in the vendor's own current documentation, quoted below.
* **REPORTED** — stated by a secondary source or a vendor summary page; likely
  true, not confirmed at the primary source.
* **REQUIRES VENDOR CONFIRMATION** — cannot be settled without talking to the
  vendor or the exchange. Assume nothing.

---

## 1. What Atlas actually needs

Before comparing anyone, the requirement, from Atlas's own instrument set and
architecture:

| need | why |
| --- | --- |
| CME, CBOT, COMEX, NYMEX | NQ/MNQ and ES/MES are CME; GC/MGC are COMEX; CL/MCL are NYMEX |
| Real-time trades | the tick pipeline, and the evidence a simulated fill is built from |
| Best bid/ask | Phase 8's foundation; the current feed has none at all |
| Historical OHLCV **and** ticks | chart history, and the candle forensics that prove it |
| An API a Node/TypeScript server can speak | Atlas's server is the client, not a desktop app |
| Contract-level symbology | Atlas must know it is trading NQZ26, not "NQ=F" |
| Continuous-contract rules | a continuous chart over a specific tradeable contract |
| Sequence numbers + exchange timestamps | gap detection and ordering that mean something |
| Redistribution to end users | Atlas shows prices to *its* traders — this is the hard part |

The last row is the one that decides the commercial answer, and it is entirely
separate from the technical one. A vendor subscription is **not** permission to
show that data to other people.

---

## 2. Databento

**Technical fit: strong. Commercial path for redistribution: slow, and
exchange-gated.**

| fact | label | source |
| --- | --- | --- |
| Official licensed distributor of futures data from CME, ICE, CBOT, NYMEX, COMEX | REPORTED | [databento.com/futures](https://databento.com/futures) |
| Dataset `GLBX.MDP3` is CME Globex MDP 3.0 — the exchange's own multicast feed | VERIFIED | [databento.com/datasets/GLBX.MDP3](https://databento.com/datasets/GLBX.MDP3) |
| "Nanosecond, PTP-synchronized timestamps", "up to four timestamps for every event, with sub-microsecond accuracy across venues" | VERIFIED | same |
| Symbology includes "Continuous contracts, options chains, rollover rules, venue-native numeric IDs, ticker symbols" | VERIFIED | same |
| Connectivity: "Raw API, which uses a binary protocol over TCP, and our HTTP API" | VERIFIED | same |
| 90th-percentile latency "42 microseconds (cross-connect) or 590 microseconds (internet)" | VERIFIED | same |
| Standard plan **$199/month**, includes live data; Plus $1,750/mo; Unlimited $4,500/mo; usage-based tier is historical only | VERIFIED | [databento.com/pricing](https://databento.com/pricing) |
| **$125 in free credits** for new users, historical only, expiring after 6 months | VERIFIED | same |
| "Most of our datasets can be redistributed internally or externally **after 24 hours**" | VERIFIED | same |
| Real-time redistribution or professional status requires a formal exchange licence/ILA; Databento introduces you to CME by email; "can take months to complete" and they advise starting 3–6 months ahead | REPORTED | [databento.com/futures](https://databento.com/futures) |
| Exchange licence fees "range from 32 USD to 20K+ USD per month per exchange" | VERIFIED | [Databento: introduction to market data licensing](https://databento.com/blog/introduction-market-data-licensing) |
| "You need a license to access real-time (live, intraday) market data if you're a professional user **or if you're distributing data externally within 24 hours of receipt**" | VERIFIED | same |
| CME non-professional display ≈ $36.50/mo; professional non-display ≈ $1,219/mo | REPORTED | [Databento announcement](https://roadmap.databento.com/announcements/live-cme-data-is-now-open-to-all-users-starting-at-3265month); the authoritative figure is the [CME fee list](https://api.databento.com/static/licensing/cme/cme-market-data-fee-list.pdf) |
| Per-subscriber tracking and reporting obligations when redistributing | VERIFIED | licensing blog, above |

**What this means for Atlas specifically.** Atlas can begin *today* on
historical data with free credits and no exchange conversation, which is enough
to build and validate the entire pipeline — contract model, tick ingestion,
candle aggregation, gap detection, forensic comparison. Live data for one
non-professional developer is a $199/month decision. Showing real-time prices
to Atlas's *users* is a different thing entirely and is gated by a CME licence
that takes months.

The 24-hour rule is the practically important one: **delayed** redistribution
is a materially easier path than real-time, and Atlas already has an honest
DELAYED mode to put it in.

---

## 3. dxFeed

**Technical fit: strong. Commercial fit for prop firms: the best of the three,
on the evidence. Pricing: not public.**

| fact | label | source |
| --- | --- | --- |
| Real-time, delayed and historical tick-level CME futures and options data | REPORTED | [dxfeed.com/market-data/futures/cme](https://dxfeed.com/market-data/futures/cme/) |
| Market-data infrastructure vendor, subsidiary of Devexperts | REPORTED | [dxfeed.com](https://dxfeed.com/) |
| Used inside prop-firm products, with the data bundled into the challenge fee — MyFundedFutures shipped dxFeed US futures on their platform (Sept 2024) | REPORTED | [propfirmapp.com review](https://propfirmapp.com/trading-tools/dxfeed), [thortradecopier comparison](https://thortradecopier.com/blog/dxfeed-vs-rithmic-data-feed-comparison) |
| CME's own API pricing "as low as $0.50/GB plus applicable ILA fees" | REPORTED | [CME real-time futures and options data API](https://www.cmegroup.com/market-data/real-time-futures-and-options-data-api.html) |
| dxFeed pricing for a redistributing platform | **REQUIRES VENDOR CONFIRMATION** | not published |
| Whether dxFeed's prop-firm arrangements cover the ILA on the platform's behalf, or merely supply the feed | **REQUIRES VENDOR CONFIRMATION** | — |

That last question is the single most valuable thing to ask them. If dxFeed's
prop-firm packaging includes the entitlement machinery, it removes the months
of exchange conversation that Databento is explicit about.

---

## 4. Rithmic

**Technical fit for Atlas today: poor. Strategic fit later: high.**

| fact | label | source |
| --- | --- | --- |
| Direct market access execution software with real-time, delayed and historical data | REPORTED | [rithmic.com](https://www.rithmic.com/) |
| R\|API+ is "a collection of C++ and .NET software libraries and interface definitions" | REPORTED | [rithmic.com/products/api-suite](https://www.rithmic.com/products/api-suite) |
| Production access requires passing **conformance** review, tied to an FCM ID | REPORTED | [Ironbeam](https://www.ironbeam.com/rithmic-api-futures-trading/) |
| The feed behind most futures prop firms | REPORTED | [thortradecopier](https://thortradecopier.com/blog/what-is-rithmic-futures-data-feed) |
| Data redistribution terms for a platform | **REQUIRES VENDOR CONFIRMATION** | not published |

Rithmic is an execution stack that happens to carry data. It assumes a broker
(FCM) relationship and a C++/.NET client. Atlas has neither, simulates its
fills, and runs a Node server. Rithmic becomes the right conversation on the
day Atlas routes a real order — not on the day it needs a better chart.

---

## 5. The comparison, in the four dimensions the brief asks for

### Technical fit

| | Databento | dxFeed | Rithmic |
| --- | --- | --- | --- |
| CME/CBOT/COMEX/NYMEX | yes | yes | yes |
| Real-time trades | yes | yes | yes |
| Bid/ask | yes (MBP-1 and deeper) | yes (L1/L2) | yes |
| Historical ticks | yes, self-serve | yes | via broker |
| Historical OHLCV | yes | yes | yes |
| Node/TypeScript client | HTTP + raw TCP; no FCM needed | vendor SDKs | C++/.NET, conformance, FCM |
| Contract symbology + continuous rules | documented, first-class | yes | yes |
| Nanosecond exchange timestamps | stated explicitly | not confirmed | not confirmed |
| Can start **today** without a sales call | **yes** | no | no |

### Commercial / licensing fit

| | Databento | dxFeed | Rithmic |
| --- | --- | --- | --- |
| Self-serve for one developer | yes | no | no |
| Real-time external redistribution | exchange ILA, months | likely packaged — CONFIRM | broker-mediated — CONFIRM |
| Delayed (24h+) redistribution | permitted for most datasets | CONFIRM | CONFIRM |
| Per-user entitlement reporting | required, on you | possibly handled — CONFIRM | CONFIRM |

### Cost

| | Databento | dxFeed | Rithmic |
| --- | --- | --- | --- |
| Development today | $0 (free historical credits) → $199/mo live | quote | quote |
| Exchange fees | passed through; $32–$20,000+/mo per exchange by status | quote | quote |
| Per end user at scale | CME per-subscriber fees apply — model in `market-data-licensing.md` | possibly bundled | broker-dependent |

### Future scale

Databento's model bills Atlas and leaves the exchange relationship with Atlas.
dxFeed's prop-firm packaging may absorb some of that. Rithmic's model assumes
the FCM carries it. For a platform that expects to serve many simulated
traders, **who carries the per-subscriber entitlement burden is the deciding
commercial question**, and it is not answerable from public pages.

---

## 6. Recommendation

**Integrate against Databento first.** Not because it is easiest to code —
because it is the only one of the three where Atlas can do real engineering
work *right now*, against real CME data, with documented nanosecond timestamps
and real contract symbology, without a sales cycle or a broker. Every part of
the pipeline this milestone builds can be validated against it on historical
data alone.

**Open the dxFeed conversation in parallel**, with one question at the top:
does their prop-firm packaging carry the exchange entitlement, and on what
terms per end user. If the answer is yes, dxFeed is probably where Atlas ends
up commercially, and the provider abstraction is what makes that switch a
adapter rather than a rewrite.

**Defer Rithmic** until Atlas routes real orders through an FCM.

### What would make Atlas switch later

* dxFeed (or another vendor) confirming per-user entitlement handling that
  removes months of exchange negotiation.
* A cost curve at 1,000+ users that favours a bundled prop-firm arrangement.
* Real order routing, which makes Rithmic's execution+data pairing compelling.
* Any vendor unable to serve the contract metadata Atlas's roll model needs.

### What this evaluation does NOT establish

* Whether Atlas may show real-time CME data to its own users, and at what fee
  per user. **REQUIRES VENDOR CONFIRMATION** and an exchange conversation.
* Whether simulated-trading users count as non-professional subscribers.
  **REQUIRES VENDOR CONFIRMATION** — this is a CME determination, not a vendor
  one, and it is worth asking early because it moves the per-user fee by an
  order of magnitude.
* dxFeed and Rithmic pricing at any scale.

---

## 7. What I need from you to go further

Nothing in this milestone can produce a live professional tick until these
exist, and I will not fabricate one:

1. **A Databento account and API key** (`DATABENTO_API_KEY`), ideally with the
   free historical credits intact. Historical access alone unblocks the entire
   pipeline, the candle forensics and the independent comparison.
2. **A decision on live data** — the $199/month Standard plan, or explicitly
   "historical only for now", which is a perfectly good answer for this stage.
3. **Whether to open the dxFeed conversation now**, and who does it.
4. **Your answer on subscriber status**: is Atlas's intended user base
   non-professional individuals, or will firms be involved? It changes the fee
   model and therefore the provider choice.

Until (1) arrives, the adapter, the contract model, the normalisation, the
fixtures and every audit around them can be built and tested against recorded
and synthetic data — and will be. What cannot be done is claiming a live
connection that does not exist.

---

## Sources

- [Databento — futures data](https://databento.com/futures)
- [Databento — GLBX.MDP3 (CME Globex MDP 3.0)](https://databento.com/datasets/GLBX.MDP3)
- [Databento — pricing](https://databento.com/pricing)
- [Databento — introduction to market data licensing](https://databento.com/blog/introduction-market-data-licensing)
- [Databento — live CME data announcement](https://roadmap.databento.com/announcements/live-cme-data-is-now-open-to-all-users-starting-at-3265month)
- [CME Group market data fee list (via Databento)](https://api.databento.com/static/licensing/cme/cme-market-data-fee-list.pdf)
- [CME Group — real-time futures and options data API](https://www.cmegroup.com/market-data/real-time-futures-and-options-data-api.html)
- [dxFeed — CME futures and options data feeds](https://dxfeed.com/market-data/futures/cme/)
- [dxFeed review and prop-firm use cases](https://propfirmapp.com/trading-tools/dxfeed)
- [dxFeed vs Rithmic comparison](https://thortradecopier.com/blog/dxfeed-vs-rithmic-data-feed-comparison)
- [Rithmic — R\|API+ suite](https://www.rithmic.com/products/api-suite)
- [Rithmic at Ironbeam — API, conformance, FCM](https://www.ironbeam.com/rithmic-api-futures-trading/)
- [What is Rithmic — the feed behind most futures prop firms](https://thortradecopier.com/blog/what-is-rithmic-futures-data-feed)
