/**
 * Enforcement pure core (Milestone 7). No I/O, no DB, no clock beyond an injected
 * `nowMs`. Holds the reason-code taxonomy, deterministic severity derivation
 * (explicit — NOT a black-box score), case-state transition validation, the
 * hold-effective predicate, and the internal→customer-safe reason mapping.
 *
 * Philosophy encoded here: a signal is not a finding; a temporary hold is not a
 * conviction; a rule breach is not misconduct; profitability/VPN/new device/travel
 * are never violations. See docs/enforcement-reason-codes.md.
 */

// ---- categories / severity / statuses --------------------------------------

export const CASE_CATEGORIES = [
  'ACCOUNT_OWNERSHIP', 'IDENTITY', 'PAYMENT', 'PAYOUT', 'SECURITY',
  'PLATFORM', 'EXECUTION', 'AUTOMATION', 'COPY', 'COLLUSION', 'GENERAL',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const CASE_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

export const CASE_STATUSES = [
  'OPEN', 'TRIAGED', 'UNDER_REVIEW', 'AWAITING_CUSTOMER', 'ESCALATED',
  'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION',
  'APPEALED', 'APPEAL_REVIEW', 'OVERTURNED', 'FINALIZED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Terminal states — no further routine transitions. */
export const TERMINAL_CASE_STATUSES: ReadonlySet<CaseStatus> = new Set([
  'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'OVERTURNED', 'FINALIZED',
]);

const TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  OPEN: ['TRIAGED', 'UNDER_REVIEW', 'RESOLVED_NO_ACTION', 'ESCALATED'],
  TRIAGED: ['UNDER_REVIEW', 'AWAITING_CUSTOMER', 'ESCALATED', 'RESOLVED_NO_ACTION'],
  UNDER_REVIEW: ['AWAITING_CUSTOMER', 'ESCALATED', 'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION'],
  AWAITING_CUSTOMER: ['UNDER_REVIEW', 'ESCALATED', 'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION'],
  ESCALATED: ['UNDER_REVIEW', 'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION'],
  CONFIRMED_VIOLATION: ['APPEALED', 'FINALIZED'],
  APPEALED: ['APPEAL_REVIEW'],
  APPEAL_REVIEW: ['OVERTURNED', 'FINALIZED', 'RESOLVED_REMEDIATED', 'AWAITING_CUSTOMER'],
  RESOLVED_NO_ACTION: [],
  RESOLVED_REMEDIATED: [],
  OVERTURNED: [],
  FINALIZED: ['APPEALED'],
};

/** Is a case status transition allowed? Deterministic; invalid transitions are rejected. */
export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

// ---- signals / evidence / actions ------------------------------------------

export const SIGNAL_SOURCES = [
  'AUTH', 'IDENTITY', 'COMMERCE', 'PAYOUT', 'EXECUTION', 'PLATFORM',
  'COPY', 'ADMIN', 'CUSTOMER_REPORT', 'PROVIDER',
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const EVIDENCE_VISIBILITIES = ['INTERNAL', 'CUSTOMER_SAFE', 'LEGAL_RESTRICTED'] as const;
export type EvidenceVisibility = (typeof EVIDENCE_VISIBILITIES)[number];

export const HOLD_SCOPES = ['CUSTOMER', 'ACCOUNT', 'PAYOUT', 'COMMERCE'] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];

export const HOLD_CAPABILITIES = ['TRADING', 'PAYOUT_REQUEST', 'PAYOUT_APPROVAL', 'PURCHASE', 'ACCESS'] as const;
export type HoldCapability = (typeof HOLD_CAPABILITIES)[number];

export const ACTION_TYPES = [
  'NO_ACTION', 'STEP_UP_VERIFICATION', 'FORCE_SESSION_REAUTH', 'REVOKE_SESSIONS',
  'TEMPORARY_TRADING_HOLD', 'TEMPORARY_PAYOUT_HOLD', 'TEMPORARY_PURCHASE_HOLD',
  'TEMPORARY_ACCOUNT_ACCESS_RESTRICTION', 'REQUEST_INFORMATION', 'REMEDIATE_TRANSACTION',
  'REMOVE_HOLD', 'ACCOUNT_TERMINATION', 'CUSTOMER_TERMINATION',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Actions that require SUPER_ADMIN authority (irreversible / punitive). */
export const SUPER_ADMIN_ACTIONS: ReadonlySet<ActionType> = new Set([
  'ACCOUNT_TERMINATION', 'CUSTOMER_TERMINATION',
]);

// ---- findings ---------------------------------------------------------------

export const FINDING_REASON_CODES = [
  'ACCOUNT_SHARING_CONFIRMED', 'IDENTITY_FRAUD_CONFIRMED', 'PAYMENT_FRAUD_CONFIRMED',
  'PAYOUT_FRAUD_CONFIRMED', 'PAYOUT_DUPLICATION_CONFIRMED', 'PLATFORM_EXPLOIT_CONFIRMED',
  'AUTOMATION_ABUSE_CONFIRMED', 'UNAUTHORIZED_ACCESS_CONFIRMED', 'COLLUSION_CONFIRMED',
  'NO_VIOLATION',
] as const;
export type FindingReasonCode = (typeof FINDING_REASON_CODES)[number];

/** Adverse (punitive) findings — these support an appeal. NO_VIOLATION never does. */
export const ADVERSE_FINDINGS: ReadonlySet<FindingReasonCode> = new Set(
  FINDING_REASON_CODES.filter((c) => c !== 'NO_VIOLATION'),
);

export function isAdverseFinding(code: string): boolean {
  return ADVERSE_FINDINGS.has(code as FindingReasonCode);
}

/**
 * Rule-breach / eligibility codes that must NEVER be recorded as an enforcement
 * finding. Kept here so tests + callers can assert the separation in code.
 */
export const NON_MISCONDUCT_CODES: ReadonlySet<string> = new Set([
  'MLL_BREACH', 'ACCOUNT_FAILED', 'CONSISTENCY_NOT_MET', 'DAILY_BALANCE_PROGRESSION_NOT_MET',
  'INSUFFICIENT_WINNING_DAYS', 'BUFFER_NOT_MET', 'PERSONAL_RISK_CONTROL',
  'DAILY_LOSS_LIMIT', 'MAX_TRADES', 'TRADING_WINDOW', 'DAILY_DRAWDOWN', 'MAX_POSITION',
]);

export function isMisconductCode(code: string): boolean {
  return isAdverseFinding(code) && !NON_MISCONDUCT_CODES.has(code);
}

// ---- customer-safe mapping --------------------------------------------------

export const CUSTOMER_SAFE_CATEGORIES = [
  'ACCOUNT_OWNERSHIP_VERIFICATION', 'IDENTITY_VERIFICATION', 'PAYMENT_REVIEW',
  'PAYOUT_REVIEW', 'SECURITY_REVIEW', 'GENERAL_REVIEW',
] as const;
export type CustomerSafeCategory = (typeof CUSTOMER_SAFE_CATEGORIES)[number];

const CATEGORY_TO_SAFE: Record<CaseCategory, CustomerSafeCategory> = {
  ACCOUNT_OWNERSHIP: 'ACCOUNT_OWNERSHIP_VERIFICATION',
  IDENTITY: 'IDENTITY_VERIFICATION',
  PAYMENT: 'PAYMENT_REVIEW',
  PAYOUT: 'PAYOUT_REVIEW',
  SECURITY: 'SECURITY_REVIEW',
  PLATFORM: 'GENERAL_REVIEW',
  EXECUTION: 'GENERAL_REVIEW',
  AUTOMATION: 'GENERAL_REVIEW',
  COPY: 'ACCOUNT_OWNERSHIP_VERIFICATION',
  COLLUSION: 'GENERAL_REVIEW',
  GENERAL: 'GENERAL_REVIEW',
};

export function customerSafeCategory(category: CaseCategory): CustomerSafeCategory {
  return CATEGORY_TO_SAFE[category] ?? 'GENERAL_REVIEW';
}

const SAFE_MESSAGE: Record<CustomerSafeCategory, string> = {
  ACCOUNT_OWNERSHIP_VERIFICATION: 'Account ownership verification',
  IDENTITY_VERIFICATION: 'Identity verification',
  PAYMENT_REVIEW: 'Payment review',
  PAYOUT_REVIEW: 'Payout review',
  SECURITY_REVIEW: 'Security review',
  GENERAL_REVIEW: 'Account review',
};

/** The only reason text a trader ever sees — never the internal reason code. */
export function customerSafeMessage(safe: CustomerSafeCategory): string {
  return SAFE_MESSAGE[safe] ?? 'Account review';
}

// ---- severity derivation (explicit, never a black-box score) ---------------

/**
 * Derive operational severity from the explicit category + signal kind. This is
 * urgency, NOT guilt. New device / IP change / VPN are INFO. Credible takeover is
 * CRITICAL. There is deliberately no numeric fraud score.
 */
export function deriveSeverity(category: CaseCategory, signalKind?: string): CaseSeverity {
  const k = signalKind ?? '';
  // Never-a-violation, informational signals.
  if (k === 'SECURITY_NEW_DEVICE' || k === 'SECURITY_IP_CHANGE' || k === 'SECURITY_UNUSUAL_LOGIN') return 'INFO';
  if (k === 'PAYOUT_DESTINATION_CHANGE' || k === 'COPY_CORRELATED_PATTERN') return 'LOW';
  // Credible security compromise / takeover → CRITICAL containment.
  if (k === 'SECURITY_CREDENTIAL_ALERT' || k === 'CUSTOMER_REPORTED_ACCESS') return 'CRITICAL';
  if (k === 'PAYOUT_DUPLICATE_ATTEMPT') return 'HIGH';
  if (category === 'SECURITY') return 'HIGH';
  if (category === 'IDENTITY' || category === 'PAYMENT' || category === 'PAYOUT') return 'MEDIUM';
  return 'LOW';
}

export function maxSeverity(a: CaseSeverity, b: CaseSeverity): CaseSeverity {
  return CASE_SEVERITIES.indexOf(a) >= CASE_SEVERITIES.indexOf(b) ? a : b;
}

// ---- hold-effective predicate ----------------------------------------------

export interface HoldLike {
  readonly status: string;
  readonly expiresAt: Date | number | null;
}

/** A hold is effective when ACTIVE and not past its expiry. Pure. */
export function holdIsEffective(hold: HoldLike, nowMs: number): boolean {
  if (hold.status !== 'ACTIVE') return false;
  if (hold.expiresAt == null) return true;
  const exp = hold.expiresAt instanceof Date ? hold.expiresAt.getTime() : Number(hold.expiresAt);
  return exp > nowMs;
}

/**
 * The exposure-INCREASING portion of an order, mirroring the risk engine's rule.
 * A trading hold uses this so it only ever blocks orders that GROW exposure — a
 * reduce/flatten/protective order (result <= 0) is always allowed.
 */
export function increasingExposure(positionQty: number, signedOrderQty: number): number {
  // Same-sign or from-flat grows exposure; opposite-sign first reduces.
  if (positionQty === 0) return Math.abs(signedOrderQty);
  const sameSign = (positionQty > 0) === (signedOrderQty > 0);
  if (sameSign) return Math.abs(signedOrderQty);
  const reduced = Math.min(Math.abs(positionQty), Math.abs(signedOrderQty));
  return Math.abs(signedOrderQty) - reduced; // any flip beyond flat is new exposure
}
