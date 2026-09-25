/**
 * Enforcement pure-core (M7). These assert the non-negotiable separations in
 * code with no database: a signal is not a finding, a rule breach is not
 * misconduct, severity is urgency (not guilt), the case machine only allows
 * legitimate transitions, and a trading hold only ever blocks exposure-INCREASING
 * orders. Being profitable / using a VPN / a new device is never, by itself, a
 * violation — encoded here as INFO severity and non-adverse handling.
 */
import { describe, expect, it } from 'vitest';
import {
  ADVERSE_FINDINGS, CASE_SEVERITIES, NON_MISCONDUCT_CODES, TERMINAL_CASE_STATUSES,
  canTransitionCase, customerSafeCategory, customerSafeMessage, deriveSeverity, holdIsEffective,
  increasingExposure, isAdverseFinding, isMisconductCode, maxSeverity,
} from './enforcement-core.js';

describe('severity is urgency, never guilt', () => {
  it('a new device is INFO', () => expect(deriveSeverity('SECURITY', 'SECURITY_NEW_DEVICE')).toBe('INFO'));
  it('an IP change / VPN is INFO', () => expect(deriveSeverity('SECURITY', 'SECURITY_IP_CHANGE')).toBe('INFO'));
  it('an unusual login is INFO', () => expect(deriveSeverity('SECURITY', 'SECURITY_UNUSUAL_LOGIN')).toBe('INFO'));
  it('a payout-destination change is only LOW', () => expect(deriveSeverity('PAYOUT', 'PAYOUT_DESTINATION_CHANGE')).toBe('LOW'));
  it('a correlated copy pattern is only LOW (similarity is not collusion)', () =>
    expect(deriveSeverity('COPY', 'COPY_CORRELATED_PATTERN')).toBe('LOW'));
  it('a credible credential alert is CRITICAL', () => expect(deriveSeverity('SECURITY', 'SECURITY_CREDENTIAL_ALERT')).toBe('CRITICAL'));
  it('a customer-reported takeover is CRITICAL', () => expect(deriveSeverity('SECURITY', 'CUSTOMER_REPORTED_ACCESS')).toBe('CRITICAL'));
  it('a duplicate payout attempt is HIGH', () => expect(deriveSeverity('PAYOUT', 'PAYOUT_DUPLICATE_ATTEMPT')).toBe('HIGH'));
  it('a bare identity review is MEDIUM', () => expect(deriveSeverity('IDENTITY')).toBe('MEDIUM'));
  it('maxSeverity keeps the more urgent of two', () => {
    expect(maxSeverity('INFO', 'HIGH')).toBe('HIGH');
    expect(maxSeverity('CRITICAL', 'LOW')).toBe('CRITICAL');
    expect(maxSeverity('LOW', 'LOW')).toBe('LOW');
  });
  it('severities are strictly ordered INFO..CRITICAL', () =>
    expect(CASE_SEVERITIES).toEqual(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']));
});

describe('a rule breach is not misconduct', () => {
  for (const code of ['MLL_BREACH', 'ACCOUNT_FAILED', 'CONSISTENCY_NOT_MET', 'DAILY_BALANCE_PROGRESSION_NOT_MET', 'PERSONAL_RISK_CONTROL', 'DAILY_LOSS_LIMIT', 'MAX_TRADES']) {
    it(`${code} is a non-misconduct code`, () => {
      expect(NON_MISCONDUCT_CODES.has(code)).toBe(true);
      expect(isMisconductCode(code)).toBe(false);
    });
  }
  it('a confirmed adverse code IS misconduct', () => {
    expect(isMisconductCode('ACCOUNT_SHARING_CONFIRMED')).toBe(true);
    expect(isMisconductCode('IDENTITY_FRAUD_CONFIRMED')).toBe(true);
  });
  it('NO_VIOLATION is neither adverse nor misconduct', () => {
    expect(isAdverseFinding('NO_VIOLATION')).toBe(false);
    expect(isMisconductCode('NO_VIOLATION')).toBe(false);
  });
  it('every adverse finding except NO_VIOLATION is appealable-eligible', () =>
    expect([...ADVERSE_FINDINGS]).not.toContain('NO_VIOLATION'));
});

describe('case state machine (no shortcuts to punishment)', () => {
  it('OPEN cannot jump straight to CONFIRMED_VIOLATION', () =>
    expect(canTransitionCase('OPEN', 'CONFIRMED_VIOLATION')).toBe(false));
  it('a review can be resolved with no action from OPEN', () =>
    expect(canTransitionCase('OPEN', 'RESOLVED_NO_ACTION')).toBe(true));
  it('UNDER_REVIEW may confirm a violation', () =>
    expect(canTransitionCase('UNDER_REVIEW', 'CONFIRMED_VIOLATION')).toBe(true));
  it('a confirmed violation can be appealed', () =>
    expect(canTransitionCase('CONFIRMED_VIOLATION', 'APPEALED')).toBe(true));
  it('terminal states do not transition onward (except finalized→appealed)', () => {
    expect(canTransitionCase('RESOLVED_NO_ACTION', 'UNDER_REVIEW')).toBe(false);
    expect(canTransitionCase('OVERTURNED', 'CONFIRMED_VIOLATION')).toBe(false);
    expect(canTransitionCase('FINALIZED', 'APPEALED')).toBe(true);
  });
  it('a self-transition is a no-op allowed', () => expect(canTransitionCase('OPEN', 'OPEN')).toBe(true));
  it('the terminal set is exactly the resolved/overturned/finalized states', () => {
    expect(TERMINAL_CASE_STATUSES.has('RESOLVED_NO_ACTION')).toBe(true);
    expect(TERMINAL_CASE_STATUSES.has('OVERTURNED')).toBe(true);
    expect(TERMINAL_CASE_STATUSES.has('OPEN')).toBe(false);
  });
});

describe('customer-safe mapping never leaks internals', () => {
  it('maps categories to safe buckets', () => {
    expect(customerSafeCategory('IDENTITY')).toBe('IDENTITY_VERIFICATION');
    expect(customerSafeCategory('PAYOUT')).toBe('PAYOUT_REVIEW');
    expect(customerSafeCategory('COLLUSION')).toBe('GENERAL_REVIEW');
  });
  it('safe messages are plain and non-accusatory', () => {
    expect(customerSafeMessage('SECURITY_REVIEW')).toBe('Security review');
    expect(customerSafeMessage('GENERAL_REVIEW')).toBe('Account review');
  });
});

describe('trading hold blocks only exposure-increasing orders', () => {
  it('opening from flat increases exposure', () => expect(increasingExposure(0, 3)).toBe(3));
  it('adding in the same direction increases exposure', () => expect(increasingExposure(2, 3)).toBe(3));
  it('reducing a long is not increasing (0)', () => expect(increasingExposure(5, -2)).toBe(0));
  it('flattening exactly is not increasing (0)', () => expect(increasingExposure(5, -5)).toBe(0));
  it('closing a short is not increasing (0)', () => expect(increasingExposure(-4, 4)).toBe(0));
  it('a flip past flat only counts the new exposure', () => expect(increasingExposure(2, -5)).toBe(3));
});

describe('holdIsEffective', () => {
  const now = 1_000_000;
  it('an active hold with no expiry is effective', () => expect(holdIsEffective({ status: 'ACTIVE', expiresAt: null }, now)).toBe(true));
  it('a released hold is never effective', () => expect(holdIsEffective({ status: 'RELEASED', expiresAt: null }, now)).toBe(false));
  it('an expired hold is not effective', () => expect(holdIsEffective({ status: 'ACTIVE', expiresAt: now - 1 }, now)).toBe(false));
  it('a future-expiry hold is effective', () => expect(holdIsEffective({ status: 'ACTIVE', expiresAt: now + 1 }, now)).toBe(true));
  it('accepts a Date expiry', () => expect(holdIsEffective({ status: 'ACTIVE', expiresAt: new Date(now + 1000) }, now)).toBe(true));
});
