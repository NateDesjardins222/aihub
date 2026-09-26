# LEGAL COUNSEL REVIEW PACKAGE

**Happy Trader Funding — plain-language description of the business for specialized counsel.** Phase 12
(2026-09-26).

> **Claude is not counsel and makes no legal conclusions.** Every item marked **COUNSEL REQUIRED** is a
> question for a qualified attorney, not an assertion. This package inventories how the software actually
> behaves so counsel can review it against the intended legal structure. Do not submit or file anything on
> this basis; do not treat any statement here as legal advice or a compliance determination.

## What the business does (as the software operates today)
Happy Trader Funding sells **evaluation products** for a **simulated futures trading** platform (Atlas).
A customer buys an evaluation, trades a **simulated** account against market data, and if they meet the
product's rules they are moved to a **funded (simulated)** stage. Performance in the funded stage can
generate **payouts** to the trader. **No customer funds are deposited or custodied**; the customer buys a
service/evaluation. All trading is simulated (paper) against market data; **no real brokerage account,
customer-owned futures account, or live customer capital exists** in the current build.

## Money flows (see MONEY_FLOW.md)
- **In:** a purchase (evaluation or reset) via a commerce provider (intended: Whop). Recorded as a
  commercial order; provisioning happens only from a signature-verified server event.
- **Out:** a **payout** to a funded trader — a 90/10 split (trader/firm) of simulated profit, subject to
  eligibility (winning days, consistency for SELECT, daily-balance progression for DAILY), caps
  (min(withdrawable, product cap, 50% of withdrawable)), a maximum of 5 paid cycles, then account
  completion. **COUNSEL REQUIRED:** how to characterize these payouts (performance-based service payout vs
  anything implying investment return).
- Purchase and payout are **separate concepts**; the firm does not hold customer trading deposits.

## The 10 commercial products
CORE 25K/50K/100K/300K GOLD; SELECT 25K/50K/100K; DAILY 25K/50K/100K. Each pins immutable rules
(starting balance, profit target, drawdown type/behavior, contract limits, consistency where applicable,
payout split/caps, winning-day requirement, funded buffer). PRACTICE is a separate free playground.

## Rules a customer is subject to (disclosure candidates)
Starting balance; profit target; max loss / drawdown type + behavior; lock behavior; contract limits;
consistency rule (SELECT); daily-balance progression (DAILY); funded payout constraints; winning-day
requirement; payout cap; profit split (90/10); max 5 payout cycles; account completion; reset policy
(re-buy at original price, new immutable account, history retained); refund policy; inactivity policy
(funded accounts require periodic trading or are closed); prohibited conduct.

## Provider dependencies (contract/terms review)
Commerce (Whop), KYC (Stripe Identity), payout provider (TBD), market data + execution (Rithmic +
exchange data rights), email (Resend), hosting, object storage. **COUNSEL/PROVIDER REQUIRED:** each
provider's terms + any redistribution/display constraints for market data.

## Enforcement / fraud philosophy (see enforcement docs)
Aggressive detection, conservative accusation, human review, appeal. Risk breach ≠ fraud; VPN/travel/
multiple devices/matching trades/fast or news trading alone are **not** violations. A versioned Trader
Pledge/policy-acceptance model exists. **COUNSEL REQUIRED:** enforceability + disclosure of conduct rules.

## Data collected (see G16 / DATA)
Customer identity (name/email/contact), KYC references (provider-held), account/trade/payout history,
support, audit. Intent is **data minimization** — hold provider references, not raw SSNs or ID images,
where the provider can custody them. **COUNSEL REQUIRED:** privacy policy, data retention (vs mandatory
financial/audit retention), and deletion-request handling.

## Marketing-language guardrails (software will conform to counsel guidance)
The product must not be described as a brokerage account, customer-owned futures account, live/real
capital, a deposit/investment, or guaranteed return. The completion metric ("× original account cost
returned in payouts") must not be presented as "investment ROI" without counsel approval. Terms like
"funded" must match the counsel-approved operating model.

## Questions for counsel (non-exhaustive)
1. Correct legal characterization of the evaluation → funded → payout model (service? something regulated?).
2. Required disclosures for simulated trading and performance payouts.
3. Terms of Service, Privacy Policy, Refund Policy, Risk Disclosure, Trader/Evaluation Agreement — content
   and required acceptance/versioning.
4. Money-transmission / custody considerations (firm does not hold customer trading deposits — confirm).
5. Tax/1099 obligations for trader payouts and affiliate commissions (with CPA).
6. Market-data redistribution/display obligations (with Rithmic + exchange).
7. Marketing-claim limits; permissible payout/return language.
8. Entity structure, signatory, and jurisdiction considerations.

## What software provides to support counsel
Authoritative product rules (`PRODUCT_SOURCE_OF_TRUTH.md`), money flow (`MONEY_FLOW.md`), financial
invariants (`FINANCIAL_INVARIANTS.md`), account state machine, enforcement model, and versioned agreement
acceptance (see G13). Legal document **drafts**, where present, are dev placeholders and are **not**
counsel-approved.

**Signatory / entity fields are placeholders requiring Nate + counsel; none are fabricated here.**
