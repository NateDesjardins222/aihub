# Owner Operability Matrix

Can Nathan operate each launch-critical customer workflow without SQL? Classified
from the Owner OS trace. CONNECTED = owner surface exists and reads the SAME
authoritative record the customer touched.

| Object | Find | Inspect | State | Ownership | History | Safe action | Status |
|---|---|---|---|---|---|---|---|
| customer | ✓ (directory/search) | ✓ Customer 360 | ✓ | ✓ | ✓ audit | tags/notes/holds | CONNECTED |
| order/purchase | ✓ | ✓ | ✓ | ✓ | ✓ | refund/reconcile | CONNECTED |
| entitlement | ✓ | ✓ | ✓ | ✓ | ✓ | — | CONNECTED |
| account | ✓ | ✓ | ✓ | ✓ | ✓ lifecycle | reset/pause/adjust | CONNECTED |
| payout | ✓ `/admin/payouts` | ✓ case | ✓ (same `payout_requests` row) | ✓ | ✓ ledger | approve/pay/fail | CONNECTED |
| certificate | ✓ | ✓ | ✓ | ✓ | ✓ | — | CONNECTED |
| support ticket | ✓ `/admin/ops/support/inbox` | ✓ workspace | ✓ (same ticket) | ✓ | ✓ thread | reply/remediate (four-eyes) | CONNECTED |
| affiliate application | ✓ `/admin/ops/affiliates/applications` (AffiliatesPages ApplicationsPanel) | ✓ | ✓ | ✓ | ✓ | approve/decline/request-info | CONNECTED |
| affiliate | ✓ | ✓ Affiliate 360 | ✓ | ✓ | ✓ | — | CONNECTED |
| provisioning failure | ✓ (PROVISION_BLOCKED/FAILED + audit/events + sweep) | ✓ | ✓ | ✓ | ✓ | retry (idempotent) | CONNECTED |
| enforcement | ✓ | ✓ | ✓ | ✓ | ✓ | case actions | CONNECTED |
| incidents / system health / reconciliation / integrity | ✓ | ✓ | ✓ | N/A | ✓ | operate | CONNECTED |

## Nathan's explicit questions, answered in code

- **"Where do affiliate applications land?"** → `affiliate_applications` table, surfaced
  at `GET /api/v1/admin/ops/affiliates/applications` and the web `AffiliatesPages.tsx`
  ApplicationsPanel (approve/decline/request-info). CONNECTED.
- **"Can Nathan see a submitted support ticket?"** → Yes. Customer `submitTicket`
  writes `support_tickets`; the same row appears in the owner support inbox and
  ticket workspace; operator replies flow back to the customer thread. CONNECTED.
- **"Paid customer with no account?"** → Recoverable + visible: order parks in
  PROVISION_BLOCKED/FAILED with audit + domain events + a recovery sweep, and the
  new `INV_STRANDED_PURCHASE` integrity detector surfaces any order still
  unprovisioned past the window. No silent black hole.

## Deferred (documented, not launch-blocking)

- Owner-side customer **journey/clubs** view beyond existing achievement/payout-ops
  surfaces.
- No owner workflow for a launch-critical object currently requires raw SQL.
