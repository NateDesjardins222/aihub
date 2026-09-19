# Market data licensing and redistribution

**This is architecture and business planning, not legal advice.** Every line is
labelled VERIFIED (read in a vendor's or exchange's own current documentation,
quoted) or **REQUIRES LEGAL/VENDOR CONFIRMATION**. Nothing here is inferred
from how other platforms appear to operate.

Researched September 2026.

---

## 1. The distinction that governs everything

A market-data subscription is permission for **you** to see data. It is not
permission to show that data to **your users**. Those are separate rights, with
separate fees, granted by the exchange rather than the vendor.

> "You need a license to access real-time (live, intraday) market data if
> you're a professional user **or if you're distributing data externally within
> 24 hours of receipt**."
> — [Databento, Introduction to market data licensing](https://databento.com/blog/introduction-market-data-licensing) — **VERIFIED**

Atlas shows prices to Atlas's traders. That is external distribution. The
24-hour clause is therefore the single most consequential sentence in this
document, and it cuts both ways:

* **Real-time to end users** → exchange licence (ILA) required, per-subscriber
  fees, reporting obligations.
* **Delayed by 24 hours or more** → "Most of our datasets can be redistributed
  internally or externally after 24 hours" ([Databento pricing](https://databento.com/pricing) — **VERIFIED**), which is a materially
  lighter path.

Atlas already has an honest DELAYED mode and already refuses to call delayed
data live. That is not a limitation to be engineered around; it is the legally
cheap position, and it should stay available deliberately.

---

## 2. Professional vs non-professional

| point | label |
| --- | --- |
| Monthly exchange licence fees "range from 32 USD to 20K+ USD per month per exchange", by subscriber status and use case ([Databento licensing](https://databento.com/blog/introduction-market-data-licensing)) | **VERIFIED** |
| CME non-professional display ≈ $36.50/month; professional non-display ≈ $1,219/month ([Databento announcement](https://roadmap.databento.com/announcements/live-cme-data-is-now-open-to-all-users-starting-at-3265month)); authoritative source is the [CME fee list](https://api.databento.com/static/licensing/cme/cme-market-data-fee-list.pdf) | **REPORTED** |
| Whether a trader using a **simulated** account on Atlas is a non-professional subscriber | **REQUIRES LEGAL/VENDOR CONFIRMATION** |
| Whether a prop-firm participant paying an evaluation fee is non-professional | **REQUIRES LEGAL/VENDOR CONFIRMATION** |
| Whether Atlas itself, as the distributing entity, is classified professional regardless of its users | **REQUIRES LEGAL/VENDOR CONFIRMATION** |

The second and third of those move the per-user cost by roughly **33×**. They
are the first questions to put to CME, through whichever vendor is chosen.

---

## 3. What each vendor's position appears to be

| | Databento | dxFeed | Rithmic |
| --- | --- | --- | --- |
| Licensed distributor of CME/CBOT/NYMEX/COMEX | REPORTED | REPORTED | REPORTED |
| Self-serve access for one developer | **VERIFIED** ($199/mo Standard incl. live) | no | no |
| Redistribution after 24h | **VERIFIED** for most datasets | CONFIRM | CONFIRM |
| Real-time redistribution | exchange ILA; vendor introduces you to CME; "can take months" — REPORTED | CONFIRM | CONFIRM |
| Per-subscriber tracking obligation on the platform | **VERIFIED** ("track your user's data usage over time") | CONFIRM | CONFIRM |
| Known prop-firm deployments | — | MyFundedFutures, Sept 2024 — REPORTED | "the feed behind most futures prop firms" — REPORTED |

**The question worth asking dxFeed first**, because it is the one that could
remove months of exchange negotiation: *does your prop-firm packaging carry the
exchange entitlement and the per-subscriber reporting, or does the platform
still hold the ILA itself?*

---

## 4. Obligations Atlas would inherit under a real-time redistribution licence

Stated so the entitlement architecture is designed for them rather than
retrofitted:

1. **Know each user's entitlement** — real-time, delayed, or none. Atlas must
   be able to serve different data quality to different users.
2. **Count and report subscribers** to the exchange, usually monthly.
3. **Classify each subscriber** professional or non-professional, with evidence.
4. **Enforce** — a user without a real-time entitlement must not receive
   real-time prices, including through a shared WebSocket.
5. **Audit** — be able to answer, months later, what a given user was served.

Atlas's WebSocket currently broadcasts one normalized stream to everyone
attached. **Per-user entitlement enforcement is therefore an architectural
change to the gateway, not a flag**, and it is the main reason the entitlement
layer (Phase 44) is worth designing now even though it will not be enforced
until there is something to enforce.

---

## 5. Unresolved questions to take to a vendor or counsel

1. Subscriber status of simulated-account users. (CME determination.)
2. Whether evaluation-fee-paying users change that status.
3. Per-user real-time fee for Atlas's expected mix, at 10 / 100 / 1,000 users.
4. Whether dxFeed's prop-firm packaging includes entitlement administration.
5. Whether a 24-hour-delayed tier can be served to unentitled users from the
   same infrastructure — and what "delayed" must mean technically to qualify.
6. Rithmic's data redistribution terms for a non-FCM platform.
7. Storage and replay rights: Atlas records sessions for its replay provider.
   Whether recorded exchange data may be replayed to users is a separate right
   from displaying it live. **REQUIRES LEGAL/VENDOR CONFIRMATION** — and it
   affects a feature that already exists.

Item 7 is the one most likely to be overlooked, because the replay feature was
built for a development feed where nobody asked.

---

## 6. The position Atlas should hold until these are answered

* Development and validation on **historical** data — no redistribution, no
  exchange conversation needed.
* Live data, if purchased, for **internal development only**, never served to
  another user.
* The delayed provider stays available and honestly labelled.
* No user-facing claim of "real-time" until an entitlement exists that makes it
  true. Atlas's existing habit of refusing to call delayed data live is the
  correct instinct and is now also the compliance position.
