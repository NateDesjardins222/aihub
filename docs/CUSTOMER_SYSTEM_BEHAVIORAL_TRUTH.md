# Customer System Behavioral Truth

What the customer system actually DOES, observably, under normal and adversarial
conditions — the behaviour a customer or operator can rely on, each tied to the
code that makes it true. This is the behavioural companion to the structural
`CUSTOMER_SURFACE_TRUTH_MATRIX.md` and the enforcement `CUSTOMER_SYSTEM_INVARIANT_LEDGER.md`.

## A customer buys an evaluation

- Nothing happens from the browser alone. The checkout success page shows a
  "we're setting up your account" state and creates nothing; only the
  signature-verified provider webhook completes the order. (`whop.ts`, inert
  success page.)
- When the webhook arrives, exactly one account appears — in the Portal and in
  Atlas, the same `accounts` row. Deliver the webhook ten times or replay it after
  a crash: still one account. (`commerce-chaos.test.ts`.)
- If provisioning can't complete, the order does not vanish: it parks in
  PROVISION_BLOCKED/FAILED, raises audit + events, a sweep retries it
  idempotently, and the `INV_STRANDED_PURCHASE` detector surfaces anything stuck.

## A customer opens the terminal

- The account switcher lists only accounts they own. Clicking "Trade" in the
  Portal hands off that account's public id; Atlas verifies it against the
  owner-scoped list and opens exactly it.
- If the handed-off account is no longer tradable (locked/failed/completed) or the
  link is stale, Atlas opens a fallback owned account AND shows a notice naming the
  requested account as unavailable — it never pretends the fallback was the request.
  (`account-selection.ts`, `HandoffNotice.tsx`, §4A.)
- A dead account cannot place an order; the server gate (`risk.ts checkOrder`)
  allows only ACTIVE/GOAL_REACHED, regardless of what any client believes.

## A customer takes a payout

- The request the customer submits and the case the owner works are the same
  `payout_requests` row. Eligibility and amounts are computed server-side; the
  Portal renders the server's decision and never computes money.
- Approval debits exactly once (unique ledger index); a second approval — even
  concurrent — is rejected. PAID flows to accounting, cycle count, lifetime-paid,
  clubs and the payout certificate as one coherent chain.
- The 5th cycle completes the account and a 6th is refused.

## A customer looks at numbers

- Every figure is server-derived and integer micro-dollars; the formatter never
  emits `$NaN` or `-0`.
- When a fetch fails, the customer sees that it failed — an error+retry banner or a
  "—" unknown — never a fabricated `0` or an empty "new customer" view. A real zero
  and an error are visibly different. (`metric-display.ts` §4B, `PortalApp.tsx`.)

## A customer contacts support / applies as an affiliate

- A submitted ticket is the exact row the owner inbox shows; replies flow back to
  the customer thread; remediation needs four eyes.
- An affiliate application is deduped: a logged-in user by their identity, an
  anonymous applicant by email. A duplicate is refused; a previously DECLINED
  applicant may re-apply. (`affiliates.ts`, §4C.)

## When things go wrong

- Server restart loses nothing: all customer truth is reconstructed from the
  database.
- Corruption is detectable: read-only integrity detectors flag stranded purchases,
  orphan accounts and cross-owner provenance, without false-alarming on legitimate
  data and counting every offender.
- The system never silently repairs money or state; detectors report, operators
  decide, and remediation is audited.

## What the system will NOT claim

- It does not claim any external production provider is verified. Rithmic,
  Whop-production, the payout rail, KYC, object storage and email are not connected
  in this environment; their fail-closed seams are proven but their live behaviour
  is EXTERNAL PRODUCTION UNVERIFIED. (`CUSTOMER_SYSTEM_CERTIFICATION.md`.)
