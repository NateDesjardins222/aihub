# 02 — The locked activation lifecycle

The single most important business rule of the program: **approval is not
activation.** No active referral code or link exists, and no commission can
accrue, until the affiliate has accepted the required agreement.

## The flow

```
APPLY → REVIEW → APPROVED_PENDING_AGREEMENT → (agreement accepted) → ACTIVE → code/link
```

State is the `affiliates.status` column. The transitions:

| From | Action | To |
| --- | --- | --- |
| — | `submitApplication` | `SUBMITTED` |
| `SUBMITTED` | `reviewApplication('APPROVE')` | `APPROVED_PENDING_AGREEMENT` |
| `SUBMITTED` | `reviewApplication('DECLINE')` | `DECLINED` |
| `SUBMITTED` | `reviewApplication('REQUEST_INFO')` | `INFO_REQUESTED` |
| `APPROVED_PENDING_AGREEMENT` | `acceptAffiliateAgreement` | `ACTIVE` (+ primary code) |
| `ACTIVE` | `setAffiliateStatus` | `PAUSED` / `SUSPENDED` / `TERMINATED` |

## Enforced invariants

- **No code before ACTIVE.** `acceptAffiliateAgreement` is the only path that
  creates the primary code (`ensurePrimaryCodeTx`). Accepting before approval is
  refused; a declined applicant can never activate.
- **Codes resolve only while ACTIVE.** `resolveActiveCode` returns null for any
  non-active affiliate, so a paused/suspended/terminated affiliate's code stops
  attributing and stops earning immediately.
- **Commission requires ACTIVE.** `processConversion` refuses with
  `AFFILIATE_NOT_ACTIVE:<status>` for any non-active affiliate.
- **One application per user.** A duplicate application for the same user is
  refused.
- **Agreement acceptance is evidence.** It is written to the append-only
  `affiliate_agreement_acceptances` table with the content hash, IP, user agent,
  and session reference; it can never be edited or deleted.
- **Data-integrity check.** `INV_ACTIVE_AFFILIATE_HAS_AGREEMENT` fails if an
  ACTIVE affiliate has no recorded acceptance version (see doc 10).

## The agreement

`ensureAffiliateAgreement` publishes a versioned `AFFILIATE_AGREEMENT` (a customer
agreement type is deliberately kept separate so the affiliate agreement never
gates ordinary customers — `outstandingAgreements` filters to
`CUSTOMER_AGREEMENT_TYPES`). The working body is clearly marked **WORKING DRAFT —
pending legal counsel review** in the text and in every UI that renders it.

## Where it is verified

- Service tests: `affiliate-lifecycle.test.ts` (apply→approve does not activate;
  accept activates + issues a code; early/declined accept refused; suspended code
  does not resolve).
- HTTP tests: `affiliate-http.test.ts` (portal shows onboarding before activation,
  dashboard after).
- Browser: `affiliate-acceptance.spec.mjs` proves the whole flow end-to-end
  through the real UI, including "approval alone does NOT activate".
