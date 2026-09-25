# 09 — Privacy and data protection

Affiliates are paid on referred customers, but they must never see who those
customers are beyond a masked label. This is a hard boundary.

## What an affiliate can NEVER see

- A referred customer's email, phone, or any contact detail.
- KYC / identity data.
- Trading activity, account balances, or the customer's own payouts.
- The customer's real name.

## How it is enforced

- **Masked names only.** `maskName` reduces a name to first-initial-plus-stars per
  part (e.g. `Nathan Desjardins` → `N***** D**********`). `listConversionsForAffiliate`
  returns the masked `customer` field and explicitly nulls out `customerName`; it
  never selects the email.
- **Scoped portal routes.** Every `/api/v1/affiliates/me*` route resolves the
  caller's *own* affiliate via `affiliateForUser` and operates only on it. There is
  no route that takes another affiliate's id in the portal.
- **No cross-affiliate read.** The owner 360 route is permission-gated
  (`affiliates.read`); an affiliate calling it gets 403.
- **IP hashing.** Click IPs are stored only as a salted hash (`hashIp`), never raw.

## Verified

- `affiliate-payouts.test.ts`: the conversion list has no `customerName`/email and
  every `customer` is masked; the dashboard JSON contains no `@…` email.
- `affiliate-security.test.ts` (HTTP): the portal conversion feed contains no raw
  email; an affiliate cannot read another affiliate's 360 or the directory.
- `affiliate-acceptance.spec.mjs` (browser): the dashboard states customers are
  masked; the conversion feed exposes no email.

## The affiliate's own data

An affiliate sees their own application, codes, balances, conversions (masked),
tier progress, and payouts. Owners, with permission, see the full internal 360.
The public program page exposes only non-sensitive program parameters.
