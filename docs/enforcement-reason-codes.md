# Enforcement Reason Codes (M7)

Stable, machine-readable codes used across signals, findings, actions, holds and
cases. Free-text internal notes are stored separately (`enforcement_notes`) and are
never the primary machine-readable reason. **Customer-safe** messages are mapped
separately from these internal codes — the internal reason is never sent to the
trader verbatim.

## Families

`IDENTITY_*` `SECURITY_*` `PAYMENT_*` `PAYOUT_*` `ACCOUNT_OWNERSHIP_*` `COPY_*`
`AUTOMATION_*` `PLATFORM_*` `EXECUTION_*` `COLLUSION_*` `ADMIN_*` `CUSTOMER_REPORTED_*`

## Signal reason codes (a signal is NOT a violation)

| Code | Meaning |
|---|---|
| `SECURITY_NEW_DEVICE` | Login from a device not seen before (INFO/LOW). |
| `SECURITY_IP_CHANGE` | Network/IP change, incl. VPN (INFO — never a violation). |
| `SECURITY_UNUSUAL_LOGIN` | Login pattern warranting a look. |
| `SECURITY_CREDENTIAL_ALERT` | Credential-stuffing / suspicious auth burst. |
| `SECURITY_SESSION_ANOMALY` | Concurrent/again-from-elsewhere session anomaly. |
| `IDENTITY_KYC_MISMATCH` | KYC provider returned a possible mismatch → REVIEW. |
| `IDENTITY_PROVIDER_UNCERTAIN` | Provider could not confirm → REVIEW. |
| `PAYMENT_CHARGEBACK` | Chargeback/dispute reported by provider (not proof). |
| `PAYMENT_MISMATCH` | Payment ownership/name mismatch signal. |
| `PAYMENT_REVERSAL` | Provider reported a transaction reversal. |
| `PAYOUT_DESTINATION_CHANGE` | Payout destination changed. |
| `PAYOUT_DUPLICATE_ATTEMPT` | Idempotency conflict on a payout movement. |
| `ACCOUNT_OWNERSHIP_MULTI_ACCESS` | Anomalous multi-party access pattern. |
| `COPY_CORRELATED_PATTERN` | Correlated cross-account/customer trade pattern. |
| `AUTOMATION_PROTECTED_ENDPOINT` | Repeated protected-endpoint failure / probing. |
| `PLATFORM_IMPOSSIBLE_STATE` | Impossible authenticated client state received. |
| `EXECUTION_ANOMALY` | Unusual execution request warranting a look. |
| `CUSTOMER_REPORTED_ACCESS` | Customer reports unrecognised access. |
| `CUSTOMER_REPORTED_PURCHASE` | Customer reports unrecognised purchase. |
| `CUSTOMER_REPORTED_PAYOUT_CHANGE` | Customer reports unrecognised payout change. |
| `ADMIN_MANUAL_REVIEW` | Operator opened a review manually. |

## Finding reason codes (evidence-supported conclusions)

| Code | Meaning |
|---|---|
| `ACCOUNT_SHARING_CONFIRMED` | Third-party trading / account sharing confirmed. |
| `IDENTITY_FRAUD_CONFIRMED` | Falsified/forged/borrowed identity confirmed. |
| `PAYMENT_FRAUD_CONFIRMED` | Deliberate payment fraud confirmed. |
| `PAYOUT_FRAUD_CONFIRMED` | Payout fraud (duplication/false destination) confirmed. |
| `PAYOUT_DUPLICATION_CONFIRMED` | Deliberate duplicate-payout attempt confirmed. |
| `PLATFORM_EXPLOIT_CONFIRMED` | Intentional platform/price/execution exploit confirmed. |
| `AUTOMATION_ABUSE_CONFIRMED` | Reverse-engineered/unauthorized automation confirmed. |
| `UNAUTHORIZED_ACCESS_CONFIRMED` | Account takeover / unauthorized access confirmed. |
| `COLLUSION_CONFIRMED` | Coordinated abuse confirmed by multiple signals. |
| `NO_VIOLATION` | Reviewed; no violation (false positive). |

A finding requires sufficient evidence. `NO_VIOLATION` is a first-class outcome and
removes temporary holds.

## Action reason codes / action types

`NO_ACTION` `STEP_UP_VERIFICATION` `FORCE_SESSION_REAUTH` `REVOKE_SESSIONS`
`TEMPORARY_TRADING_HOLD` `TEMPORARY_PAYOUT_HOLD` `TEMPORARY_PURCHASE_HOLD`
`TEMPORARY_ACCOUNT_ACCESS_RESTRICTION` `REQUEST_INFORMATION` `REMEDIATE_TRANSACTION`
`REMOVE_HOLD` `ACCOUNT_TERMINATION` `CUSTOMER_TERMINATION`

Punitive actions (`ACCOUNT_TERMINATION`, `CUSTOMER_TERMINATION`) require SUPER_ADMIN.
Temporary containment (`REVOKE_SESSIONS`, `TEMPORARY_*_HOLD`) may precede a finding
when credible money/security risk exists — containment is **not** a conviction.

## Hold capabilities & scopes

Scopes: `CUSTOMER` `ACCOUNT` `PAYOUT` `COMMERCE`.
Capabilities: `TRADING` `PAYOUT_REQUEST` `PAYOUT_APPROVAL` `PURCHASE` `ACCESS`.

Hold reason codes reuse the action/finding families, e.g.
`SECURITY_UNAUTHORIZED_ACCESS`, `ACCOUNT_OWNERSHIP_REVIEW`, `PAYMENT_DISPUTE_REVIEW`,
`PAYOUT_REVIEW`, `IDENTITY_REVIEW`.

## Payout eligibility codes (existing, distinct from holds)

The payout engine already returns `RISK_HOLD`, `FRAUD_HOLD`, `MANUAL_REVIEW`,
`ACCOUNT_LOCKED`, etc. M7 adds a **separate** enforcement-hold reason surfaced as
`ENFORCEMENT_HOLD` in the payout eligibility path so the UI can distinguish
"Eligible, temporarily under review" from "Not eligible" (economic ineligibility).

## Rule-breach vs misconduct (must stay separate)

These are **not** enforcement reason codes and must never map to a finding:

- MLL breach → account/risk failure.
- Consistency not met → eligibility delay.
- Daily progressive payout balance not met → payout ineligible.
- Personal risk control blocked an order → personal risk control.

## Customer-safe reason categories (mapped, never internal codes)

`ACCOUNT_OWNERSHIP_VERIFICATION` · `IDENTITY_VERIFICATION` · `PAYMENT_REVIEW` ·
`PAYOUT_REVIEW` · `SECURITY_REVIEW` · `GENERAL_REVIEW`. Each maps to plain-language
copy (e.g. "Account ownership verification") and never exposes thresholds,
fingerprints, other customers, or detection logic.
