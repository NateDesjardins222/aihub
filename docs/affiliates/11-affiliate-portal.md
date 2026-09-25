# 11 — The public site and the affiliate portal

## Public program (`/affiliates`, pre-sign-in)

Its own lazy-loaded bundle, rendered before the sign-in gate so a shared referral
link and the application form work for anyone. Premium, restrained (black / white /
chrome). Routes:

- `/affiliates` — landing: hero, "how it works", and the commission-tier table.
  Rates and thresholds come from `GET /api/v1/affiliates/program`; nothing is
  hardcoded. **No guaranteed-income / get-rich / risk-free language appears.**
- `/affiliates/apply` — application form (`POST /apply`, rate-limited 5/min).
- `/affiliates/agreement` — the working agreement, prominently marked pending legal
  counsel review.

A `?ref=<CODE>` on any `/affiliates` URL records a first-party click (doc 03).

## Affiliate portal (`/affiliates/portal`, behind sign-in)

Its own bundle, behind the sign-in gate. Three states driven by `GET /me`:

1. **Not enrolled** → an invitation to apply.
2. **Onboarding** → status; when `APPROVED_PENDING_AGREEMENT`, the agreement with a
   consent checkbox and an **Accept & activate** button (`POST /me/accept-agreement`).
3. **Active dashboard** →
   - balance stats: withdrawable, available, pending, in-flight, lifetime paid;
   - **referral link** (`…/affiliates?ref=<CODE>`) with copy buttons, and a
     campaign-code creator (`POST /me/codes`, attribution-only);
   - **tier progress** with a bar toward the next tier;
   - **last 30 days** clicks / visitors / conversions / referred revenue / rate;
   - **referred conversions** (customer names masked);
   - **payouts** with truthful provider status and a request form (`POST /me/payouts`).

Every portal route is scoped to the caller's own affiliate; there is no way to name
another affiliate's id (doc 09).

## Endpoints

Public: `GET /program`, `GET /agreement`, `POST /apply`, `POST /click`.
Portal: `GET /me`, `GET /me/agreement`, `POST /me/accept-agreement`,
`GET /me/conversions`, `GET /me/payouts`, `POST /me/payouts`, `POST /me/codes`.
