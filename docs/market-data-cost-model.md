# Market data: cost model

What Atlas would pay for market data at four sizes. Where a number is
published it is cited; where it requires a sales quote it says so rather than
being invented. **No pricing in this document is guessed.**

Researched September 2026.

---

## 1. The three cost layers

They are billed separately and behave differently with scale, so they are
modelled separately.

| layer | who bills it | scales with |
| --- | --- | --- |
| **Vendor platform fee** | Databento / dxFeed / Rithmic | flat, per plan |
| **Exchange licence fees** | CME (passed through) | **per subscriber**, by status |
| **Infrastructure** | hosting | events/sec, storage, bandwidth |

The middle layer is the one that decides whether a business works. A flat
vendor fee at 10 users is the same at 1,000; CME's per-subscriber fee is not.

---

## 2. Known prices

| item | price | label |
| --- | --- | --- |
| Databento Standard (live + historical, one developer) | **$199/month** | VERIFIED — [pricing](https://databento.com/pricing) |
| Databento Plus | **$1,750/month** (annual) | VERIFIED |
| Databento Unlimited | **$4,500/month** (annual) | VERIFIED |
| Databento historical, usage-based | **$/GB**, with **$125 free credits** for new users (6-month expiry) | VERIFIED |
| Exchange licence fees, general range | **$32 to $20,000+/month per exchange** | VERIFIED — [licensing](https://databento.com/blog/introduction-market-data-licensing) |
| CME non-professional display, per subscriber | **≈ $36.50/month** | REPORTED — [announcement](https://roadmap.databento.com/announcements/live-cme-data-is-now-open-to-all-users-starting-at-3265month); authoritative source is the [CME fee list](https://api.databento.com/static/licensing/cme/cme-market-data-fee-list.pdf) |
| CME professional non-display | **≈ $1,219/month** | REPORTED — same |
| CME real-time API | "as low as $0.50/GB plus applicable ILA fees" | REPORTED — [CME](https://www.cmegroup.com/market-data/real-time-futures-and-options-data-api.html) |
| dxFeed, any tier | — | **REQUIRES SALES QUOTE** |
| Rithmic, any tier | — | **REQUIRES SALES QUOTE** |

---

## 3. Scenarios

Three assumptions are stated because they drive everything, and two of them
are unconfirmed:

* **A1** Atlas's users are classified **non-professional**. **UNCONFIRMED** —
  see `market-data-licensing.md` §2. If false, multiply the per-user line by
  roughly 33.
* **A2** Real-time to end users requires per-subscriber CME fees at the
  non-professional display rate (~$36.50/user/month). REPORTED.
* **A3** A 24-hour-delayed tier avoids per-subscriber fees. Derived from the
  VERIFIED 24-hour redistribution clause, but the technical definition of
  "delayed" for that purpose is **UNCONFIRMED**.

### Development today (1 user, no redistribution)

| line | cost |
| --- | --- |
| Historical only, free credits | **$0** until credits are spent |
| Live for one developer (Standard) | **$199/month** |
| Exchange fees | none stated for Standard ("no license fees") — VERIFIED |
| **Total** | **$0 – $199/month** |

This is the only row in this document that can be acted on without a sales
call or an exchange conversation.

### 10 users, real-time

| line | cost |
| --- | --- |
| Vendor platform | $199–$1,750/month, tier depending |
| CME per subscriber (A1, A2) | 10 × ~$36.50 = **~$365/month** |
| Infrastructure | modest; one normalized stream serves all |
| **Total** | **~$565 – $2,100/month** |

### 100 users, real-time

| line | cost |
| --- | --- |
| Vendor platform | likely $1,750/month tier |
| CME per subscriber | 100 × ~$36.50 = **~$3,650/month** |
| **Total** | **~$5,400/month**, dominated by per-subscriber fees |

### 1,000 users, real-time

| line | cost |
| --- | --- |
| Vendor platform | $4,500/month or negotiated |
| CME per subscriber | 1,000 × ~$36.50 = **~$36,500/month** |
| **Total** | **~$41,000/month** — the vendor fee is now noise |

### 10,000 users, real-time

Per-subscriber fees at ~$365,000/month make the published rate card
irrelevant; at that size the arrangement is negotiated, and this is precisely
where a prop-firm packaging deal (dxFeed) or an enterprise exchange agreement
changes the economics. **REQUIRES SALES QUOTE.**

### The delayed alternative, at any size

If A3 holds, a 24-hour-delayed tier carries **no per-subscriber exchange fee**,
which turns the 1,000-user line from ~$41,000/month into the vendor fee alone.
For a simulated-trading product this is not a compromise to be embarrassed
about — and Atlas already has the honest DELAYED plumbing to serve it.

---

## 4. What this means for the product

1. **Per-subscriber exchange fees, not the vendor, are the business model
   question.** Any plan that assumes vendor pricing scales is wrong.
2. **A delayed tier is a real product decision**, not a fallback — it may be
   the difference between a viable cost base and an impossible one.
3. **Entitlement architecture pays for itself immediately**: serving real-time
   only to users who are paid for is what keeps the per-subscriber line
   proportional to revenue.
4. **The subscriber-status question (A1) is worth answering before any
   contract is signed.** It is a 33× swing.

---

## 5. Not modelled

* Historical storage and request volume at scale (depends on retention policy).
* Bandwidth (small relative to the above; one normalized stream fans out).
* dxFeed and Rithmic entirely — **REQUIRES SALES QUOTE**.
* Any discount, commitment or prop-firm arrangement.
