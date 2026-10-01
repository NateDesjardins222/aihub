# Portal V2 — Owner Dependencies

What Portal V2 depends on from the **Owner Console / backend workstream**, and the boundaries
Portal V2 must never cross. Portal V2 is a customer-facing read/compose layer over authoritative
records owned elsewhere.

## Hard boundaries (Portal V2 never touches)
- **Owner Console** is a separate, server-authorized application at `/admin`. Portal V2 never
  renders it, never embeds it, and never puts it in customer nav. The owner-only account-menu
  entry shows a truthful notice that points to `/admin` (dev `?role=owner` only). Its links and
  contracts are preserved.
- **Atlas terminal** (charting/execution) is a separate workstream. Portal V2 does not modify
  it; the "Trade ↗" handoff routes to `/?account=<publicId>` and must keep working.
- **Business rules & economics** (evaluation rules, breach, payout eligibility, profit splits,
  pricing) are server-authoritative and unchanged by Portal V2.

## Records Portal V2 consumes (owned by backend/Owner workstreams)
| Capability | Owner/source |
|---|---|
| Accounts projection + account detail/analytics | accounts projection + analytics services |
| Payout standing / history / eligibility | payout engine read model |
| Certificates + rendered artifacts + verification | certificate renderer + storage (Milestone 6) |
| Orders / entitlements / provenance | commerce engine read model |
| Payment method (safe projection) | payment provider via commerce |
| Profile (display name) | profile service |
| Identity / KYC status | identity-verification provider + onboarding |
| MFA / sessions | auth service |
| Support tickets | support read model |
| Notifications categories/channels | notification service |

## What this phase needs from owners (to fully wire production)
These are the additive, read-only projections the presentational components already expect:
1. **Portfolio cumulative-P&L series** endpoint (dashboard chart). *(seam)*
2. **Certificate artifact** auth endpoints already exist (`/:id/{image,pdf}`) — confirm they
   remain the single artifact source for the V2 vault.
3. **Payment-method safe projection** + **provider-hosted manage** URL. *(seam)*
4. **Receipt** endpoint for settled orders. *(seam)*
5. **Notification preferences** write path if channel toggles become customer-editable (today
   presented as desk-managed, read-only). *(seam)*

Each is additive (a projection or a provider redirect). **No second source of truth** is
introduced, and nothing here changes economics or business rules.

## Escalation triggers (HARD STOP + report, do not proceed)
Cross-tenant data access, raw card storage, review-fixture leakage into production, or any
change that would alter economics/business rules.

---
## Review #3 — confirmed operator coverage
- **Support**: operator endpoints EXIST (`/api/v1/admin/ops/support`, permission-gated) and an admin
  web UI exists — customer ticketing is operationally complete today (not a new Owner Console dep).
- **Certificates**: renderer/storage/verification exist; V2 consumes them. Owner issuance/revocation
  remains the owner workstream.
- Review #3 built NO Owner Console. Portfolio-P&L projection endpoint + payment-provider management
  URL + receipts remain the additive seams listed above.
