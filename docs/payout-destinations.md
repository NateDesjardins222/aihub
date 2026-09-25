# Payout Destinations (Milestone 8)

A payout destination is *where* a customer's money goes. Handling it is where the
worst data-protection mistakes happen, so the rule is absolute:

> **Happy Trader never stores raw bank credentials, card secrets, provider secrets
> or plaintext identity documents.** A destination is a **provider token** plus a
> **masked display string**. Nothing else about the underlying instrument is
> persisted, logged, or ever returned to a browser.

Source: `apps/server/src/platform/payout-destinations.ts`, the
`payout_destinations` table (`schema.ts`), the portal routes in
`http/routes/payout-ops.ts`.

---

## The data model

`payout_destinations` stores, per destination:

- `customerIdentityId` — the owning identity (destinations are identity-scoped).
- `provider` + `providerRef` — the **provider's** reference/token for the
  destination. This is opaque to us; it is not a bank number.
- `destinationType` — e.g. `BANK_ACCOUNT`, `CARD`, `WALLET` (category only).
- `maskedDisplay` — the only human-readable string, e.g. `•••• 4321`. Safe to show.
- `ownershipState` — `OWNERSHIP_UNVERIFIED | OWNERSHIP_CONFIRMED | OWNERSHIP_MISMATCH`.
- `status` — `PENDING | VERIFICATION_REQUIRED | ACTIVE | REJECTED | DISABLED`.
- `capability`, `version`, and lifecycle timestamps.

There is deliberately **no column** for an account number, routing number, IBAN,
card PAN, CVV, or any secret. The schema itself makes storing them impossible.

---

## Adding a destination

`addDestination(db, { organizationId, customerIdentityId, provider, providerRef })`:

1. Calls the provider's `validateDestination` (the provider — not us — sees any
   sensitive input and returns a token + a masked display + an ownership verdict).
2. Maps the verdict onto our states:
   - ownership **CONFIRMED** → `status = ACTIVE` (payable).
   - ownership **MISMATCH** → `status = REJECTED` (never payable; needs review).
   - otherwise → `VERIFICATION_REQUIRED` / `PENDING`.
3. Persists only the token, masked display, type, and states; publishes
   `payout.destination_added` (and `payout.destination_verification_required`
   when verification is pending).

`isPayable(destination)` is true only for an `ACTIVE`, ownership-confirmed,
non-disabled destination. The fast lane's `DESTINATION` check uses exactly this;
a payout with no payable destination parks in `DESTINATION_REVIEW` (eligible,
delayed — never denied).

`activeDestination(db, identityId, provider)` resolves the destination a payout
will actually use.

---

## The trader surface (Payout Methods)

`/portal/payout-ops/destinations` (page: `PayoutMethodsPage.tsx`) is strictly
own-scoped and masked:

- **GET** lists only the caller's own destinations, returning `maskedDisplay`,
  type, status and ownership — **never `providerRef`**. The HTTP tests assert the
  raw reference never appears in the response body.
- **POST** (dev/mock flow) synthesizes a provider token via the mock and stores it.
  It **refuses** when no provider is configured (`PROVIDER_UNCONFIGURED`) and when
  the configured provider is a real, hosted one (`PROVIDER_HOSTED_REQUIRED`) — a
  real provider owns its own hosted capture flow; we never build a form that
  collects bank fields ourselves.
- **POST `/:id/disable`** is IDOR-safe: it 404s unless the destination belongs to
  the caller's identity, so trader A can never disable trader B's method.

---

## Verification and ownership

Ownership is the provider's judgement, surfaced honestly:

- `OWNERSHIP_CONFIRMED` — the trader owns the destination; payable.
- `OWNERSHIP_MISMATCH` — the name/owner does not match; **rejected**, routed to a
  `DESTINATION_REVIEW` exception rather than paid to the wrong person.
- Pending verification shows the trader a "verification pending" state and a
  `payout.destination_verification_required` notification, not an error.

`markDestinationVerified` promotes a destination to `ACTIVE` once verified;
`disableDestination` retires one (audited).

---

## What is never allowed

- No raw account/routing/IBAN/PAN/CVV/secret is stored, logged, or returned.
- The owner console shows the same masked display — the operation detail carries
  the provider **payout id** (an opaque `mock_…` / vendor token), never a raw
  destination reference. The browser acceptance suite asserts `mock_dest_` never
  reaches either the owner console or the trader page.
- A mismatched-ownership destination is never paid; it becomes an exception a human
  resolves.
